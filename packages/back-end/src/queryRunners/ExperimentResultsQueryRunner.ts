import { analyzeExperimentPower } from "shared/enterprise";
import { addDays } from "date-fns";
import {
  expandMetricGroups,
  ExperimentMetricInterface,
  getAllMetricIdsFromExperiment,
  isFactMetric,
  isRatioMetric,
  quantileMetricType,
} from "shared/experiments";
import { FALLBACK_EXPERIMENT_MAX_LENGTH_DAYS } from "shared/constants";
import { daysBetween } from "shared/dates";
import chunk from "lodash/chunk";
import { orgHasPremiumFeature } from "back-end/src/enterprise";
import { ApiReqContext } from "back-end/types/api";
import {
  ExperimentSnapshotAnalysis,
  ExperimentSnapshotHealth,
  ExperimentSnapshotInterface,
  ExperimentSnapshotSettings,
} from "back-end/types/experiment-snapshot";
import { MetricInterface } from "back-end/types/metric";
import { Queries, QueryPointer, QueryStatus } from "back-end/types/query";
import { SegmentInterface } from "back-end/types/segment";
import {
  findSnapshotById,
  updateSnapshot,
} from "back-end/src/models/ExperimentSnapshotModel";
import { parseDimensionId } from "back-end/src/services/experiments";
import {
  analyzeExperimentResults,
  analyzeExperimentTraffic,
} from "back-end/src/services/stats";
import {
  ExperimentAggregateUnitsQueryResponseRows,
  ExperimentDimension,
  ExperimentFactMetricsQueryParams,
  ExperimentMetricQueryParams,
  ExperimentMetricStats,
  ExperimentQueryResponses,
  ExperimentResults,
  ExperimentUnitsQueryParams,
  SourceIntegrationInterface,
} from "back-end/src/types/Integration";
import { expandDenominatorMetrics } from "back-end/src/util/sql";
import { FactTableMap } from "back-end/src/models/FactTableModel";
import { OrganizationInterface } from "back-end/types/organization";
import { FactMetricInterface } from "back-end/types/fact-table";
import SqlIntegration from "back-end/src/integrations/SqlIntegration";
import { updateReport } from "back-end/src/models/ReportModel";
import { BanditResult } from "back-end/types/experiment";
import {
  QueryRunner,
  QueryMap,
  ProcessedRowsType,
  RowsType,
  StartQueryParams,
} from "./QueryRunner";

export type SnapshotResult = {
  unknownVariations: string[];
  multipleExposures: number;
  analyses: ExperimentSnapshotAnalysis[];
  banditResult?: BanditResult;
  health?: ExperimentSnapshotHealth;
};

export type ExperimentResultsQueryParams = {
  snapshotSettings: ExperimentSnapshotSettings;
  variationNames: string[];
  metricMap: Map<string, ExperimentMetricInterface>;
  factTableMap: FactTableMap;
  queryParentId: string;
};

export const TRAFFIC_QUERY_NAME = "traffic";

export const UNITS_TABLE_PREFIX = "growthbook_tmp_units";

export const MAX_METRICS_PER_QUERY = 20;

export function getFactMetricGroup(metric: FactMetricInterface) {
  // Ratio metrics must have the same numerator and denominator fact table to be grouped
  if (isRatioMetric(metric)) {
    if (metric.numerator.factTableId !== metric.denominator?.factTableId) {
      return "";
    }
  }

  // Quantile metrics get their own group to prevent slowing down the main query
  if (quantileMetricType(metric)) {
    return metric.numerator.factTableId
      ? `${metric.numerator.factTableId} (quantile metrics)`
      : "";
  }
  return metric.numerator.factTableId || "";
}

export interface GroupedMetrics {
  groups: FactMetricInterface[][];
  singles: ExperimentMetricInterface[];
}

export function getFactMetricGroups(
  metrics: ExperimentMetricInterface[],
  settings: ExperimentSnapshotSettings,
  integration: SourceIntegrationInterface,
  organization: OrganizationInterface
): GroupedMetrics {
  const defaultReturn: GroupedMetrics = {
    groups: [],
    singles: metrics,
  };

  // Metrics might have different conversion windows which makes the query super complicated
  if (settings.skipPartialData) {
    return defaultReturn;
  }
  // Combining metrics in a single query is an Enterprise-only feature
  if (!orgHasPremiumFeature(organization, "multi-metric-queries")) {
    return defaultReturn;
  }

  // Org-level setting (in case the multi-metric query introduces bugs)
  if (organization.settings?.disableMultiMetricQueries) {
    return defaultReturn;
  }

  // Group metrics by fact table id
  const groups: Record<string, FactMetricInterface[]> = {};
  metrics.forEach((m) => {
    // Only fact metrics
    if (!isFactMetric(m)) return;

    // Skip grouping metrics with percentile caps or quantile metrics if there's not an efficient implementation
    if (
      (m.cappingSettings.type === "percentile" || quantileMetricType(m)) &&
      !integration.getSourceProperties().hasEfficientPercentiles
    ) {
      return;
    }

    const group = getFactMetricGroup(m);
    if (group) {
      groups[group] = groups[group] || [];
      groups[group].push(m);
    }
  });

  const groupArrays: FactMetricInterface[][] = [];
  Object.values(groups).forEach((group) => {
    // Split groups into chunks of MAX_METRICS_PER_QUERY
    const chunks = chunk(group, MAX_METRICS_PER_QUERY);
    groupArrays.push(...chunks);
  });

  // Add any metrics that aren't in groupArrays to the singles array
  const singles: ExperimentMetricInterface[] = [];
  metrics.forEach((m) => {
    if (!isFactMetric(m) || !groupArrays.some((group) => group.includes(m))) {
      singles.push(m);
    }
  });

  return {
    groups: groupArrays,
    singles,
  };
}

export const startExperimentResultQueries = async (
  context: ApiReqContext,
  params: ExperimentResultsQueryParams,
  integration: SourceIntegrationInterface,
  startQuery: (
    params: StartQueryParams<RowsType, ProcessedRowsType>
  ) => Promise<QueryPointer>
): Promise<Queries> => {
  const snapshotSettings = params.snapshotSettings;
  const queryParentId = params.queryParentId;
  const metricMap = params.metricMap;

  const { org } = context;
  const hasPipelineModeFeature = orgHasPremiumFeature(org, "pipeline-mode");

  const activationMetric = snapshotSettings.activationMetric
    ? metricMap.get(snapshotSettings.activationMetric) ?? null
    : null;

  // Only include metrics tied to this experiment (both goal and guardrail metrics)
  const allMetricGroups = await context.models.metricGroups.getAll();
  const selectedMetrics = expandMetricGroups(
    getAllMetricIdsFromExperiment(snapshotSettings, false),
    allMetricGroups
  )
    .map((m) => metricMap.get(m))
    .filter((m) => m) as ExperimentMetricInterface[];
  if (!selectedMetrics.length) {
    throw new Error("Experiment must have at least 1 metric selected.");
  }

  let segmentObj: SegmentInterface | null = null;
  if (snapshotSettings.segment) {
    segmentObj = await context.models.segments.getById(
      snapshotSettings.segment
    );
  }

  const settings = integration.datasource.settings;

  const exposureQuery = (settings?.queries?.exposure || []).find(
    (q) => q.id === snapshotSettings.exposureQueryId
  );

  const dimensionObj = await parseDimensionId(
    snapshotSettings.dimensions[0]?.id,
    org.id
  );

  const queries: Queries = [];

  // Settings for units table
  const useUnitsTable =
    (integration.getSourceProperties().supportsWritingTables &&
      settings.pipelineSettings?.allowWriting &&
      !!settings.pipelineSettings?.writeDataset &&
      hasPipelineModeFeature) ??
    false;
  let unitQuery: QueryPointer | null = null;
  const unitsTableFullName =
    useUnitsTable && !!integration.generateTablePath
      ? integration.generateTablePath(
          `${UNITS_TABLE_PREFIX}_${queryParentId}`,
          settings.pipelineSettings?.writeDataset,
          settings.pipelineSettings?.writeDatabase,
          true
        )
      : "";

  // Settings for health query
  const runTrafficQuery = !dimensionObj && org.settings?.runHealthTrafficQuery;
  let dimensionsForTraffic: ExperimentDimension[] = [];
  if (runTrafficQuery && exposureQuery?.dimensionMetadata) {
    dimensionsForTraffic = exposureQuery.dimensionMetadata
      .filter((dm) => exposureQuery.dimensions.includes(dm.dimension))
      .map((dm) => ({
        type: "experiment",
        id: dm.dimension,
        specifiedSlices: dm.specifiedSlices,
      }));
  }

  const unitQueryParams: ExperimentUnitsQueryParams = {
    activationMetric: activationMetric,
    dimensions: dimensionObj ? [dimensionObj] : dimensionsForTraffic,
    segment: segmentObj,
    settings: snapshotSettings,
    unitsTableFullName: unitsTableFullName,
    includeIdJoins: true,
    factTableMap: params.factTableMap,
  };

  if (useUnitsTable) {
    // The Mixpanel integration does not support writing tables
    if (!integration.generateTablePath) {
      throw new Error(
        "Unable to generate table; table path generator not specified."
      );
    }
    unitQuery = await startQuery({
      name: queryParentId,
      query: integration.getExperimentUnitsTableQuery(unitQueryParams),
      dependencies: [],
      run: (query, setExternalId) =>
        integration.runExperimentUnitsQuery(query, setExternalId),
      process: (rows) => rows,
      queryType: "experimentUnits",
    });
    queries.push(unitQuery);
  }

  const { groups, singles } = getFactMetricGroups(
    selectedMetrics,
    params.snapshotSettings,
    integration,
    org
  );

  for (const m of singles) {
    const denominatorMetrics: MetricInterface[] = [];
    if (!isFactMetric(m) && m.denominator) {
      denominatorMetrics.push(
        ...expandDenominatorMetrics(
          m.denominator,
          metricMap as Map<string, MetricInterface>
        )
          .map((m) => metricMap.get(m) as MetricInterface)
          .filter(Boolean)
      );
    }
    const queryParams: ExperimentMetricQueryParams = {
      activationMetric,
      denominatorMetrics,
      dimensions: dimensionObj ? [dimensionObj] : [],
      metric: m,
      segment: segmentObj,
      settings: snapshotSettings,
      unitsSource: unitQuery ? "exposureTable" : "exposureQuery",
      unitsTableFullName: unitsTableFullName,
      factTableMap: params.factTableMap,
    };
    queries.push(
      await startQuery({
        name: m.id,
        query: integration.getExperimentMetricQuery(queryParams),
        dependencies: unitQuery ? [unitQuery.query] : [],
        run: (query, setExternalId) =>
          integration.runExperimentMetricQuery(query, setExternalId),
        process: (rows) => rows,
        queryType: "experimentMetric",
      })
    );
  }

  for (const [i, m] of groups.entries()) {
    const queryParams: ExperimentFactMetricsQueryParams = {
      activationMetric,
      dimensions: dimensionObj ? [dimensionObj] : [],
      metrics: m,
      segment: segmentObj,
      settings: snapshotSettings,
      unitsSource: unitQuery ? "exposureTable" : "exposureQuery",
      unitsTableFullName: unitsTableFullName,
      factTableMap: params.factTableMap,
    };

    if (
      !integration.getExperimentFactMetricsQuery ||
      !integration.runExperimentFactMetricsQuery
    ) {
      throw new Error("Integration does not support multi-metric queries");
    }

    queries.push(
      await startQuery({
        name: `group_${i}`,
        query: integration.getExperimentFactMetricsQuery(queryParams),
        dependencies: unitQuery ? [unitQuery.query] : [],
        run: (query, setExternalId) =>
          (integration as SqlIntegration).runExperimentFactMetricsQuery(
            query,
            setExternalId
          ),
        process: (rows) => rows,
        queryType: "experimentMultiMetric",
      })
    );
  }

  let trafficQuery: QueryPointer | null = null;
  if (runTrafficQuery) {
    trafficQuery = await startQuery({
      name: TRAFFIC_QUERY_NAME,
      query: integration.getExperimentAggregateUnitsQuery({
        ...unitQueryParams,
        dimensions: dimensionsForTraffic,
        useUnitsTable: !!unitQuery,
      }),
      dependencies: unitQuery ? [unitQuery.query] : [],
      run: (query, setExternalId) =>
        integration.runExperimentAggregateUnitsQuery(query, setExternalId),
      process: (rows) => rows,
      queryType: "experimentTraffic",
    });
    queries.push(trafficQuery);
  }

  const dropUnitsTable =
    integration.getSourceProperties().dropUnitsTable &&
    settings.pipelineSettings?.unitsTableDeletion;
  if (useUnitsTable && dropUnitsTable) {
    const dropUnitsTableQuery = await startQuery({
      name: `drop_${queryParentId}`,
      query: integration.getDropUnitsTableQuery({
        fullTablePath: unitsTableFullName,
      }),
      dependencies: [],
      // all other queries in model must succeed or fail first
      runAtEnd: true,
      run: (query, setExternalId) =>
        integration.runDropTableQuery(query, setExternalId),
      process: (rows) => rows,
      queryType: "experimentDropUnitsTable",
    });
    queries.push(dropUnitsTableQuery);
  }

  return queries;
};

export class ExperimentResultsQueryRunner extends QueryRunner<
  ExperimentSnapshotInterface,
  ExperimentResultsQueryParams,
  SnapshotResult
> {
  private variationNames: string[] = [];
  private metricMap: Map<string, ExperimentMetricInterface> = new Map();

  checkPermissions(): boolean {
    return this.context.permissions.canRunExperimentQueries(
      this.integration.datasource
    );
  }

  async startQueries(params: ExperimentResultsQueryParams): Promise<Queries> {
    this.metricMap = params.metricMap;
    this.variationNames = params.variationNames;
    if (
      this.integration.getSourceProperties().separateExperimentResultQueries
    ) {
      return startExperimentResultQueries(
        this.context,
        params,
        this.integration,
        this.startQuery.bind(this)
      );
    } else {
      return this.startLegacyQueries(params);
    }
  }

  async runAnalysis(queryMap: QueryMap): Promise<SnapshotResult> {
    const {
      results: analysesResults,
      banditResult,
    } = await analyzeExperimentResults({
      queryData: queryMap,
      snapshotSettings: this.model.settings,
      analysisSettings: this.model.analyses.map((a) => a.settings),
      variationNames: this.variationNames,
      metricMap: this.metricMap,
    });

    const result: SnapshotResult = {
      analyses: this.model.analyses,
      multipleExposures: 0,
      unknownVariations: [],
      banditResult,
    };

    analysesResults.forEach((results, i) => {
      const analysis = this.model.analyses[i];
      if (!analysis) return;

      analysis.results = results.dimensions || [];
      analysis.status = "success";
      analysis.error = "";

      // TODO: do this once, not per analysis
      result.unknownVariations = results.unknownVariations || [];
      result.multipleExposures = results.multipleExposures ?? 0;
    });

    // Run health checks
    const healthQuery = queryMap.get(TRAFFIC_QUERY_NAME);
    if (healthQuery) {
      const rows = healthQuery.result as ExperimentAggregateUnitsQueryResponseRows;
      const trafficHealth = analyzeExperimentTraffic({
        rows: rows,
        error: healthQuery.error,
        variations: this.model.settings.variations,
      });

      result.health = {
        traffic: trafficHealth,
      };

      const relativeAnalysis = this.model.analyses.find(
        (a) => a.settings.differenceType === "relative"
      );

      const isEligibleForMidExperimentPowerAnalysis =
        relativeAnalysis &&
        this.model.settings.banditSettings === undefined &&
        rows &&
        rows.length;

      if (isEligibleForMidExperimentPowerAnalysis) {
        const today = new Date();
        const phaseStartDate = this.model.settings.startDate;
        const experimentMaxLengthDays = this.context.org.settings
          ?.experimentMaxLengthDays;

        const experimentTargetEndDate = addDays(
          phaseStartDate,
          experimentMaxLengthDays && experimentMaxLengthDays > 0
            ? experimentMaxLengthDays
            : FALLBACK_EXPERIMENT_MAX_LENGTH_DAYS
        );
        const targetDaysRemaining = daysBetween(today, experimentTargetEndDate);
        // NB: This does not run a SQL query, but it is a health check that depends on the trafficHealth
        result.health.power = analyzeExperimentPower({
          trafficHealth,
          targetDaysRemaining,
          analysis: relativeAnalysis,
          goalMetrics: this.model.settings.goalMetrics,
          variationsSettings: this.model.settings.variations,
        });
      }
    }

    return result;
  }

  async getLatestModel(): Promise<ExperimentSnapshotInterface> {
    const obj = await findSnapshotById(this.model.organization, this.model.id);
    if (!obj)
      throw new Error("Could not load snapshot model: " + this.model.id);
    return obj;
  }

  async updateModel({
    status,
    queries,
    runStarted,
    result,
    error,
  }: {
    status: QueryStatus;
    queries: Queries;
    runStarted?: Date;
    result?: SnapshotResult;
    error?: string;
  }): Promise<ExperimentSnapshotInterface> {
    const updates: Partial<ExperimentSnapshotInterface> = {
      queries,
      runStarted,
      error,
      ...result,
      status:
        status === "running"
          ? "running"
          : status === "failed"
          ? "error"
          : "success",
    };
    await updateSnapshot({
      organization: this.model.organization,
      id: this.model.id,
      updates,
      context: this.context,
    });
    if (
      this.model.report &&
      ["failed", "partially-succeeded", "succeeded"].includes(status)
    ) {
      await updateReport(this.model.organization, this.model.report, {
        snapshot: this.model.id,
      });
    }
    return {
      ...this.model,
      ...updates,
    };
  }

  private async startLegacyQueries(
    params: ExperimentResultsQueryParams
  ): Promise<Queries> {
    const snapshotSettings = params.snapshotSettings;
    const metricMap = params.metricMap;

    const activationMetric = snapshotSettings.activationMetric
      ? metricMap.get(snapshotSettings.activationMetric) ?? null
      : null;

    // Only include metrics tied to this experiment (both goal and guardrail metrics)
    const selectedMetrics = getAllMetricIdsFromExperiment(
      snapshotSettings,
      false
    )
      .map((m) => metricMap.get(m))
      .filter((m) => m) as ExperimentMetricInterface[];
    if (!selectedMetrics.length) {
      throw new Error("Experiment must have at least 1 metric selected.");
    }

    const dimensionObj = await parseDimensionId(
      snapshotSettings.dimensions[0]?.id,
      this.model.organization
    );

    const dimension =
      dimensionObj?.type === "user" ? dimensionObj.dimension : null;
    const query = this.integration.getExperimentResultsQuery(
      snapshotSettings,
      selectedMetrics,
      activationMetric,
      dimension
    );

    return [
      await this.startQuery({
        queryType: "experimentResults",
        name: "results",
        query: query,
        dependencies: [],
        run: async () => {
          const rows = (await this.integration.getExperimentResults(
            snapshotSettings,
            selectedMetrics,
            activationMetric,
            dimension
            // eslint-disable-next-line
          )) as any[];
          return { rows: rows };
        },
        process: (rows: ExperimentQueryResponses) =>
          this.processLegacyExperimentResultsResponse(snapshotSettings, rows),
      }),
    ];
  }

  private processLegacyExperimentResultsResponse(
    snapshotSettings: ExperimentSnapshotSettings,
    rows: ExperimentQueryResponses
  ): ExperimentResults {
    const ret: ExperimentResults = {
      dimensions: [],
      unknownVariations: [],
    };

    const variationMap = new Map<string, number>();
    snapshotSettings.variations.forEach((v, i) => variationMap.set(v.id, i));

    const unknownVariations: Map<string, number> = new Map();
    let totalUsers = 0;

    const dimensionMap = new Map<string, number>();

    rows.forEach(({ dimension, metrics, users, variation }) => {
      let i = 0;
      if (dimensionMap.has(dimension)) {
        i = dimensionMap.get(dimension) || 0;
      } else {
        i = ret.dimensions.length;
        ret.dimensions.push({
          dimension,
          variations: [],
        });
        dimensionMap.set(dimension, i);
      }

      const numUsers = users || 0;
      totalUsers += numUsers;

      const varIndex = variationMap.get(variation + "");
      if (
        typeof varIndex === "undefined" ||
        varIndex < 0 ||
        varIndex >= snapshotSettings.variations.length
      ) {
        unknownVariations.set(variation, numUsers);
        return;
      }

      const metricData: { [key: string]: ExperimentMetricStats } = {};
      metrics.forEach(({ metric, ...stats }) => {
        metricData[metric] = stats;
      });

      ret.dimensions[i].variations.push({
        variation: varIndex,
        users: numUsers,
        metrics: metricData,
      });
    });

    unknownVariations.forEach((users, variation) => {
      // Ignore unknown variations with an insignificant number of users
      // This protects against random typos causing false positives
      if (totalUsers > 0 && users / totalUsers >= 0.02) {
        ret.unknownVariations.push(variation);
      }
    });

    return ret;
  }
}
