import { DataSourceInterfaceWithParams } from "back-end/types/datasource";
import { DimensionInterface } from "back-end/types/dimension";
import { MetricInterface } from "back-end/types/metric";
import { SegmentInterface } from "back-end/types/segment";
import { ProjectInterface } from "back-end/types/project";
import {
  useContext,
  useMemo,
  createContext,
  FC,
  ReactNode,
  useCallback,
  ReactElement,
} from "react";
import { TagInterface } from "back-end/types/tag";
import {
  FactMetricInterface,
  FactTableInterface,
} from "back-end/types/fact-table";
import { ExperimentMetricInterface, isFactMetricId } from "shared/experiments";
import { SavedGroupInterface } from "shared/src/types";
import { MetricGroupInterface } from "back-end/types/metric-groups";
import { CustomField } from "back-end/types/custom-fields";
import { DecisionCriteriaInterface } from "back-end/types/experiment";
import { WebhookSecretFrontEndInterface } from "back-end/src/validators/webhook-secrets";
import useApi from "@/hooks/useApi";
import { useLocalStorage } from "@/hooks/useLocalStorage";
import LoadingOverlay from "@/components/LoadingOverlay";
import { findClosestRadixColor } from "./tags";

type Definitions = {
  metrics: MetricInterface[];
  _metricsIncludingArchived: MetricInterface[];
  datasources: DataSourceInterfaceWithParams[];
  dimensions: DimensionInterface[];
  segments: SegmentInterface[];
  projects: ProjectInterface[];
  savedGroups: SavedGroupInterface[];
  metricGroups: MetricGroupInterface[];
  customFields: CustomField[];
  tags: TagInterface[];
  factTables: FactTableInterface[];
  _factTablesIncludingArchived: FactTableInterface[];
  factMetrics: FactMetricInterface[];
  _factMetricsIncludingArchived: FactMetricInterface[];
  decisionCriteria: DecisionCriteriaInterface[];
  webhookSecrets: WebhookSecretFrontEndInterface[];
};

type DefinitionContextValue = Definitions & {
  ready: boolean;
  error?: string;
  project: string;
  setProject: (id: string) => void;
  refreshTags: (newTags: string[]) => Promise<void>;
  mutateDefinitions: (changes?: Partial<Definitions>) => Promise<void>;
  getMetricById: (id: string) => null | MetricInterface;
  getDatasourceById: (id: string) => null | DataSourceInterfaceWithParams;
  getDimensionById: (id: string) => null | DimensionInterface;
  getSegmentById: (id: string) => null | SegmentInterface;
  getProjectById: (id: string) => null | ProjectInterface;
  getSavedGroupById: (id: string) => null | SavedGroupInterface;
  getTagById: (id: string) => null | TagInterface;
  getFactTableById: (id: string) => null | FactTableInterface;
  getFactMetricById: (id: string) => null | FactMetricInterface;
  getExperimentMetricById: (id: string) => null | ExperimentMetricInterface;
  getMetricGroupById: (id: string) => null | MetricGroupInterface;
  getDecisionCriteriaById: (id: string) => null | DecisionCriteriaInterface;
};

const defaultValue: DefinitionContextValue = {
  ready: false,
  mutateDefinitions: async () => {
    /* do nothing */
  },
  refreshTags: async () => {
    /* do nothing */
  },
  setProject: () => {
    /* do nothing */
  },
  project: "",
  metrics: [],
  _metricsIncludingArchived: [],
  datasources: [],
  dimensions: [],
  segments: [],
  tags: [],
  savedGroups: [],
  metricGroups: [],
  customFields: [],
  projects: [],
  factTables: [],
  _factTablesIncludingArchived: [],
  factMetrics: [],
  _factMetricsIncludingArchived: [],
  decisionCriteria: [],
  webhookSecrets: [],
  getMetricById: () => null,
  getDatasourceById: () => null,
  getDimensionById: () => null,
  getSegmentById: () => null,
  getProjectById: () => null,
  getSavedGroupById: () => null,
  getTagById: () => null,
  getFactTableById: () => null,
  getFactMetricById: () => null,
  getExperimentMetricById: () => null,
  getMetricGroupById: () => null,
  getDecisionCriteriaById: () => null,
};

export const DefinitionsContext = createContext<DefinitionContextValue>(
  defaultValue
);

interface IndexableItem {
  id: string;
}
function useGetById<T extends IndexableItem>(
  items?: T[]
): (id: string) => T | null {
  return useMemo(() => {
    if (!items) {
      // eslint-disable-next-line
      return () => null;
    }

    const m = new Map<string, T>();
    items.forEach((item) => {
      m.set(item.id, item);
    });
    return (id: string) => {
      return m.get(id) || null;
    };
  }, [items]);
}

export function useDefinitions() {
  return useContext(DefinitionsContext);
}

export const LOCALSTORAGE_PROJECT_KEY = "gb_current_project" as const;

export const useProject = () => useLocalStorage(LOCALSTORAGE_PROJECT_KEY, "");

export const DefinitionsProvider: FC<{ children: ReactNode }> = ({
  children,
}) => {
  const { data, error, mutate } = useApi<Definitions & { status: 200 }>(
    "/organization/definitions"
  );

  const [project, setProject] = useProject();

  const activeMetrics = useMemo(() => {
    if (!data || !data.metrics) {
      return [];
    }
    return data.metrics.filter((m) => m.status !== "archived");
  }, [data?.metrics]);

  const allMetrics = useMemo(() => {
    if (!data || !data.metrics) {
      return [];
    }
    return data.metrics;
  }, [data?.metrics]);

  const metricGroups = useMemo(() => {
    if (!data || !data.metricGroups) {
      return [];
    }
    return data.metricGroups;
  }, [data?.metricGroups]);

  const decisionCriteria = useMemo(() => {
    if (!data || !data.decisionCriteria) {
      return [];
    }
    return data.decisionCriteria;
  }, [data?.decisionCriteria]);

  const activeFactMetrics = useMemo(() => {
    if (!data || !data.factMetrics) {
      return [];
    }
    return data.factMetrics.filter((m) => {
      const numeratorFactTable = data.factTables.find(
        (f) => f.id === m.denominator?.factTableId
      );
      const denominatorFactTable = m.denominator?.factTableId
        ? data.factTables.find((f) => f.id === m.denominator?.factTableId)
        : null;

      return (
        !m.archived &&
        !numeratorFactTable?.archived &&
        !denominatorFactTable?.archived
      );
    });
  }, [data?.factMetrics]);

  const allFactMetrics = useMemo(() => {
    if (!data || !data.factMetrics) {
      return [];
    }
    return data.factMetrics;
  }, [data?.factMetrics]);

  const activeFactTables = useMemo(() => {
    if (!data || !data.factTables) {
      return [];
    }

    return data.factTables.filter((t) => !t.archived);
  }, [data?.factTables]);

  const allFactTables = useMemo(() => {
    if (!data || !data.factTables) {
      return [];
    }

    return data.factTables;
  }, [data?.factTables]);

  const allTags = useMemo(() => {
    if (!data || !data.tags) {
      return [];
    }

    return data.tags.map((tag) => {
      if (tag.color.charAt(0) === "#") {
        return { ...tag, color: findClosestRadixColor(tag.color) as string };
      }

      return tag;
    });
  }, [data?.tags]);

  const getMetricById = useGetById(data?.metrics);
  const getDatasourceById = useGetById(data?.datasources);
  const getDimensionById = useGetById(data?.dimensions);
  const getSegmentById = useGetById(data?.segments);
  const getProjectById = useGetById(data?.projects);
  const getSavedGroupById = useGetById(data?.savedGroups);
  const getTagById = useGetById(allTags);
  const getFactTableById = useGetById(data?.factTables);
  const getFactMetricById = useGetById(data?.factMetrics);
  const getMetricGroupById = useGetById(data?.metricGroups);
  const getDecisionCriteriaById = useGetById(data?.decisionCriteria);

  const getExperimentMetricById = useCallback(
    (id: string) => {
      if (isFactMetricId(id)) {
        return getFactMetricById(id);
      }
      return getMetricById(id);
    },
    [getMetricById, getFactMetricById]
  );

  let value: DefinitionContextValue;
  if (error) {
    value = { ...defaultValue, setProject, error: error?.message || "" };
  } else if (!data) {
    value = defaultValue;
  } else {
    const filteredProject =
      data.projects && data.projects.map((p) => p.id).includes(project)
        ? project
        : "";
    value = {
      ready: true,
      metrics: activeMetrics,
      _metricsIncludingArchived: allMetrics,
      datasources: data.datasources,
      dimensions: data.dimensions,
      segments: data.segments,
      tags: allTags,
      savedGroups: data.savedGroups,
      metricGroups: metricGroups,
      customFields: data.customFields,
      projects: data.projects,
      project: filteredProject,
      factTables: activeFactTables,
      _factTablesIncludingArchived: allFactTables,
      factMetrics: activeFactMetrics,
      _factMetricsIncludingArchived: allFactMetrics,
      decisionCriteria: decisionCriteria,
      webhookSecrets: data.webhookSecrets,
      setProject,
      getMetricById,
      getDatasourceById,
      getDimensionById,
      getSegmentById,
      getProjectById,
      getSavedGroupById,
      getTagById,
      getFactTableById,
      getFactMetricById,
      getExperimentMetricById,
      getMetricGroupById,
      getDecisionCriteriaById,
      refreshTags: async (tags) => {
        const existingTags = data.tags.map((t) => t.id);
        const newTags = tags.filter((t) => !existingTags.includes(t));

        if (newTags.length > 0) {
          await mutate(
            {
              ...data,
              tags: data.tags.concat(
                newTags.map((t) => ({
                  id: t,
                  color: "blue",
                  description: "",
                }))
              ),
            },
            false
          );
        }
      },
      mutateDefinitions: async (changes) => {
        await mutate(Object.assign({ ...data }, changes), true);
      },
    };
  }

  return (
    <DefinitionsContext.Provider value={value}>
      {children}
    </DefinitionsContext.Provider>
  );
};

export function DefinitionsGuard({ children }: { children: ReactElement }) {
  const { ready, error } = useDefinitions();

  if (!error && !ready) {
    return <LoadingOverlay />;
  }

  return children;
}
