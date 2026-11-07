// Only imported by the lazily-loaded admin dashboard chunk.
import * as echarts from "echarts/core";
import { BarChart, LineChart } from "echarts/charts";
import { BrushComponent, GridComponent, ToolboxComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";

echarts.use([LineChart, BarChart, GridComponent, TooltipComponent, BrushComponent, ToolboxComponent, CanvasRenderer]);

export { echarts };
