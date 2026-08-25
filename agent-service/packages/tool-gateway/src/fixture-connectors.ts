import {
  getServiceTopologyInputSchema,
  getServiceTopologyOutputSchema,
  queryLogsInputSchema,
  queryLogsOutputSchema,
  queryMetricsInputSchema,
  queryMetricsOutputSchema,
  searchRunbookInputSchema,
  searchRunbookOutputSchema,
  type GetServiceTopologyInput,
  type GetServiceTopologyOutput,
  type LogConnector,
  type MetricConnector,
  type QueryLogsInput,
  type QueryLogsOutput,
  type QueryMetricsInput,
  type QueryMetricsOutput,
  type RunbookConnector,
  type SearchRunbookInput,
  type SearchRunbookOutput,
  type ServiceTopologyConnector,
} from './contracts.js';
import { findFixtureScenario } from './fixtures.js';

/** 将文本统一为小写，便于 Fixture 查询使用不区分大小写的匹配。
 * @param value 待转换的文本。
 * @returns 小写文本。
 */
function lower(value: string): string {
  return value.toLocaleLowerCase();
}

/** 判断时间戳是否位于闭区间内。
 * @param timestamp 待判断的时间戳。
 * @param startTime 查询开始时间。
 * @param endTime 查询结束时间。
 * @returns 时间戳是否在查询范围内。
 */
function inRange(timestamp: string, startTime: string, endTime: string): boolean {
  const value = Date.parse(timestamp);
  return value >= Date.parse(startTime) && value <= Date.parse(endTime);
}

/** 检查 Connector 调用是否已被上游取消。
 * @param signal 上游 Agent Run 的取消信号。
 */
function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

/** 创建未知 Fixture 服务错误。
 * @param service 请求的服务名称。
 * @returns 描述服务不存在的错误。
 */
function unknownServiceError(service: string): Error {
  return new Error(`No fixture service named ${service}.`);
}

/** 创建查询无匹配数据错误。
 * @param message 查询失败的具体原因。
 * @returns 描述无匹配结果的错误。
 */
function noMatchingDataError(message: string): Error {
  return new Error(message);
}

/** 基于 Fixture 数据实现日志 Connector。 */
export class FixtureLogConnector implements LogConnector {
  /** 查询 Fixture 日志并再次校验输入输出边界。
   * @param input 日志查询参数。
   * @param signal 上游 Agent Run 的取消信号。
   * @returns 过滤后的日志和来源 metadata。
   */
  async query(input: QueryLogsInput, signal?: AbortSignal): Promise<QueryLogsOutput> {
    throwIfAborted(signal);
    const parsedInput = queryLogsInputSchema.parse(input);
    const scenario = findFixtureScenario(parsedInput.service);
    if (scenario === undefined) throw unknownServiceError(parsedInput.service);

    const query = parsedInput.query === undefined ? undefined : lower(parsedInput.query);
    const entries = scenario.logs.filter(
      (entry) =>
        inRange(entry.timestamp, parsedInput.startTime, parsedInput.endTime) &&
        (query === undefined ||
          lower(`${entry.message} ${JSON.stringify(entry.attributes ?? {})}`).includes(query)),
    );
    if (entries.length === 0) {
      throw noMatchingDataError(
        'No log entries matched the requested service, time range, and query.',
      );
    }

    const noteworthy =
      entries
        .filter((entry) => entry.level === 'ERROR')
        .map((entry) => entry.message)
        .at(-1) ?? entries.at(-1)!.message;
    return queryLogsOutputSchema.parse({
      entries,
      count: entries.length,
      summary: `${parsedInput.service}: ${noteworthy} (${entries.length} matching log entries).`,
      sourceUri: scenario.sourceUris.logs,
      timeRangeStart: parsedInput.startTime,
      timeRangeEnd: parsedInput.endTime,
    });
  }
}

/** 基于 Fixture 数据实现指标 Connector。 */
export class FixtureMetricConnector implements MetricConnector {
  /** 查询 Fixture 指标并再次校验输入输出边界。
   * @param input 指标查询参数。
   * @param signal 上游 Agent Run 的取消信号。
   * @returns 过滤后的指标和来源 metadata。
   */
  async query(input: QueryMetricsInput, signal?: AbortSignal): Promise<QueryMetricsOutput> {
    throwIfAborted(signal);
    const parsedInput = queryMetricsInputSchema.parse(input);
    const scenario = findFixtureScenario(parsedInput.service);
    if (scenario === undefined) throw unknownServiceError(parsedInput.service);

    const series = scenario.metrics.find((value) => value.metric === parsedInput.metric);
    if (series === undefined) {
      throw noMatchingDataError(
        `No ${parsedInput.metric} metric is available for ${parsedInput.service}.`,
      );
    }
    const samples = series.samples.filter((sample) =>
      inRange(sample.timestamp, parsedInput.startTime, parsedInput.endTime),
    );
    if (samples.length === 0) {
      throw noMatchingDataError('No metric samples matched the requested time range.');
    }

    const latest = samples.at(-1)!;
    return queryMetricsOutputSchema.parse({
      metric: series.metric,
      unit: series.unit,
      samples,
      summary: `${parsedInput.service} ${series.metric} was ${latest.value} ${series.unit} at ${latest.timestamp}.`,
      sourceUri: scenario.sourceUris.metrics,
      timeRangeStart: parsedInput.startTime,
      timeRangeEnd: parsedInput.endTime,
    });
  }
}

/** 基于 Fixture 数据实现 Runbook Connector。 */
export class FixtureRunbookConnector implements RunbookConnector {
  /** 搜索 Fixture Runbook 并再次校验输入输出边界。
   * @param input Runbook 搜索参数。
   * @param signal 上游 Agent Run 的取消信号。
   * @returns 匹配的段落和来源 metadata。
   */
  async search(input: SearchRunbookInput, signal?: AbortSignal): Promise<SearchRunbookOutput> {
    throwIfAborted(signal);
    const parsedInput = searchRunbookInputSchema.parse(input);
    const scenario = findFixtureScenario(parsedInput.service);
    if (scenario === undefined) throw unknownServiceError(parsedInput.service);

    const query = lower(parsedInput.query);
    const excerpts = scenario.runbook.markdown
      .split(/\n\s*\n/)
      .filter((paragraph) => lower(paragraph).includes(query));
    if (excerpts.length === 0) {
      throw noMatchingDataError('No runbook excerpt matched the requested query.');
    }

    return searchRunbookOutputSchema.parse({
      title: scenario.runbook.title,
      excerpts,
      summary: `${scenario.runbook.title} returned ${excerpts.length} matching excerpt(s) for "${parsedInput.query}".`,
      sourceUri: scenario.runbook.sourceUri,
    });
  }
}

/** 基于 Fixture 数据实现服务拓扑 Connector。 */
export class FixtureServiceTopologyConnector implements ServiceTopologyConnector {
  /** 查询 Fixture 服务拓扑并再次校验输入输出边界。
   * @param input 服务拓扑查询参数。
   * @param signal 上游 Agent Run 的取消信号。
   * @returns 服务拓扑和来源 metadata。
   */
  async get(
    input: GetServiceTopologyInput,
    signal?: AbortSignal,
  ): Promise<GetServiceTopologyOutput> {
    throwIfAborted(signal);
    const parsedInput = getServiceTopologyInputSchema.parse(input);
    const scenario = findFixtureScenario(parsedInput.service);
    if (scenario === undefined) throw unknownServiceError(parsedInput.service);

    return getServiceTopologyOutputSchema.parse({
      ...scenario.topology,
      summary: `${parsedInput.service} has ${scenario.topology.upstream.length} upstream and ${scenario.topology.downstream.length} downstream dependency entries.`,
      sourceUri: scenario.sourceUris.topology,
    });
  }
}
