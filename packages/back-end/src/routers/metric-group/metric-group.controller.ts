import { Response } from "express";
import { AuthRequest } from "back-end/src/types/AuthRequest";
import { getContextFromReq } from "back-end/src/services/organizations";
import {
  CreateMetricGroupProps,
  MetricGroupInterface,
} from "back-end/types/metric-groups";
import { getDataSourceById } from "back-end/src/models/DataSourceModel";
import { removeMetricFromExperiments } from "back-end/src/models/ExperimentModel";
import { createApiRequestHandler } from "back-end/src/util/handler";
import {
  getMetricGroupsValidator,
  postMetricGroupValidator,
  putMetricGroupValidator,
  deleteMetricGroupValidator,
  putMetricGroupReorderValidator,
  removeMetricFromGroupValidator,
} from "back-end/src/validators/openapi";
import {
  GetMetricGroupsResponse,
  PostMetricGroupResponse,
  PutMetricGroupResponse,
  DeleteMetricGroupResponse,
  PutMetricGroupReorderResponse,
  RemoveMetricFromGroupResponse,
} from "back-end/types/openapi";

export const getMetricGroups = createApiRequestHandler(
  getMetricGroupsValidator
)(
  async (req): Promise<GetMetricGroupsResponse> => {
    const metricGroups = (
      await req.context.models.metricGroups.getAll()
    ).map((mg: MetricGroupInterface) =>
      req.context.models.metricGroups.toApiInterface(mg)
    );
    return { metricGroups };
  }
);

export const postMetricGroup = createApiRequestHandler(
  postMetricGroupValidator
)(
  async (req): Promise<PostMetricGroupResponse> => {
    const data = req.body;
    const context = req.context;
    if (!context.permissions.canCreateMetricGroup()) {
      context.permissions.throwPermissionError();
    }
    const datasourceDoc = await getDataSourceById(context, data.datasource);
    if (!datasourceDoc) {
      throw new Error("Invalid data source");
    }
    const baseMetricGroup = {
      ...data,
      owner: data.owner || "",
      description: data.description || "",
      tags: data.tags || [],
      projects: data.projects || [],
      archived: data.archived || false,
      metrics: data.metrics || [],
    };
    const doc = await context.models.metricGroups.create(baseMetricGroup);
    return { metricGroup: context.models.metricGroups.toApiInterface(doc) };
  }
);

export const putMetricGroup = createApiRequestHandler(putMetricGroupValidator)(
  async (req): Promise<PutMetricGroupResponse> => {
    const data = req.body;
    const context = req.context;
    const { org } = context;
    const metricGroup = await context.models.metricGroups.getById(
      req.params.id
    );
    if (!metricGroup) {
      throw new Error("Could not find metric group with that id");
    }
    if (org.id !== metricGroup.organization) {
      throw new Error("You don't have access to that metric group");
    }
    if (!context.permissions.canUpdateMetricGroup()) {
      context.permissions.throwPermissionError();
    }
    const datasourceDoc = await getDataSourceById(
      context,
      data?.datasource || metricGroup.datasource
    );
    if (!datasourceDoc) {
      throw new Error("Invalid data source");
    }
    const updated = await context.models.metricGroups.updateById(
      req.params.id,
      data
    );
    return { metricGroup: context.models.metricGroups.toApiInterface(updated) };
  }
);

export const deleteMetricGroup = createApiRequestHandler(
  deleteMetricGroupValidator
)(
  async (req): Promise<DeleteMetricGroupResponse> => {
    const context = req.context;
    if (!context.permissions.canDeleteMetricGroup()) {
      context.permissions.throwPermissionError();
    }
    const metricGroup = await context.models.metricGroups.getById(
      req.params.id
    );
    if (!metricGroup) {
      throw new Error("Could not find the metric group");
    }
    // should we delete all references to this metric group in the experiments?
    await removeMetricFromExperiments(context, metricGroup.id);
    await context.models.metricGroups.delete(metricGroup);
    return { status: "success" };
  }
);

// reorder metrics within a group
export const putMetricGroupReorder = createApiRequestHandler(
  putMetricGroupReorderValidator
)(
  async (req): Promise<PutMetricGroupReorderResponse> => {
    const context = req.context;
    const { id } = req.params;
    const metricGroup = await context.models.metricGroups.getById(id);
    if (!metricGroup) {
      throw new Error("Could not find metric group with that id");
    }
    if (!context.permissions.canUpdateMetricGroup()) {
      context.permissions.throwPermissionError();
    }
    if (metricGroup.organization !== context.org.id) {
      throw new Error("You don't have access to that metric group");
    }
    const { from, to } = req.body;
    const existingMetrics = [...metricGroup.metrics];
    const [removed] = existingMetrics.splice(from, 1);
    existingMetrics.splice(to, 0, removed);
    const updated = await context.models.metricGroups.updateById(id, {
      metrics: existingMetrics,
    });
    return { metricGroup: context.models.metricGroups.toApiInterface(updated) };
  }
);

// remove a metric from a group
export const removeMetricFromGroup = createApiRequestHandler(
  removeMetricFromGroupValidator
)(
  async (req): Promise<RemoveMetricFromGroupResponse> => {
    const context = req.context;
    const { id, metricId } = req.params;
    const metricGroup = await context.models.metricGroups.getById(id);
    if (!metricGroup) {
      throw new Error("Could not find metric group with that id");
    }
    if (!context.permissions.canUpdateMetricGroup()) {
      context.permissions.throwPermissionError();
    }
    if (metricGroup.organization !== context.org.id) {
      throw new Error("You don't have access to that metric group");
    }
    const existingMetrics = [...metricGroup.metrics];
    const index = existingMetrics.indexOf(metricId);
    if (index === -1) {
      throw new Error("Could not find metric in group");
    }
    existingMetrics.splice(index, 1);
    const updated = await context.models.metricGroups.updateById(id, {
      metrics: existingMetrics,
    });
    return { metricGroup: context.models.metricGroups.toApiInterface(updated) };
  }
);
