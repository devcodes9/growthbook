import express from "express";
import z from "zod";
import { wrapController } from "back-end/src/routers/wrapController";
import { validateRequestMiddleware } from "back-end/src/routers/utils/validateRequestMiddleware";
import {
  createMetricGroupPropsValidator,
  updateMetricGroupPropsValidator,
  updateOrderValidator,
} from "./metric-group.validators";
import * as rawMetricGroupController from "./metric-group.controller";

const router = express.Router();

const metricGroupController = wrapController(rawMetricGroupController);

router.get("/", metricGroupController.getMetricGroups);

router.post("/", metricGroupController.postMetricGroup);

router.put("/:id", metricGroupController.putMetricGroup);

router.delete(":id", metricGroupController.deleteMetricGroup);

router.put(":id/reorder", metricGroupController.putMetricGroupReorder);

router.delete(
  ":id/remove/:metricId",
  metricGroupController.removeMetricFromGroup
);

export { router as metricGroupRouter };
