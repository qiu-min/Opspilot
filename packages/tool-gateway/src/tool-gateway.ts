import { toolDefinitions, type ToolCall, type ToolDefinition, type ToolFailureResult, type ToolGateway, type ToolName, type ToolResult } from './contracts.js';
import { findFixtureScenario } from './fixtures.js';

const lower = (value: string) => value.toLocaleLowerCase();
const inRange = (timestamp: string, startTime: string, endTime: string) => {
  const value = Date.parse(timestamp);
  return value >= Date.parse(startTime) && value <= Date.parse(endTime);
};

function failure(call: Pick<ToolCall, 'callId' | 'name'>, errorCode: ToolFailureResult['errorCode'], message: string): ToolFailureResult {
  return { ok: false, callId: call.callId, name: call.name, errorCode, message };
}

export class FixtureToolGateway implements ToolGateway {
  listTools(): readonly ToolDefinition[] { return toolDefinitions; }

  async execute(callInput: ToolCall): Promise<ToolResult> {
    const raw = callInput as Partial<ToolCall>;
    if (typeof raw.callId !== 'string' || raw.callId.trim().length === 0 || typeof raw.name !== 'string') {
      return { ok: false, callId: typeof raw.callId === 'string' && raw.callId.trim().length > 0 ? raw.callId : 'unknown', name: typeof raw.name === 'string' ? raw.name : 'unknown', errorCode: 'INVALID_ARGUMENTS', message: 'Tool call must include a valid callId, name, and arguments.' };
    }
    if (!toolDefinitions.some((tool) => tool.name === raw.name)) {
      return { ok: false, callId: raw.callId, name: raw.name, errorCode: 'UNKNOWN_TOOL', message: `Tool ${raw.name} is not available.` };
    }
    const call = { callId: raw.callId, name: raw.name as ToolName, arguments: raw.arguments };
    const definition = toolDefinitions.find((tool) => tool.name === call.name)!;
    const parsedArguments = definition.inputSchema.safeParse(call.arguments);
    if (!parsedArguments.success) return failure(call, 'INVALID_ARGUMENTS', `Arguments for ${call.name} are invalid.`);

    switch (call.name) {
      case 'queryLogs': return this.queryLogs(call, parsedArguments.data as { service: string; startTime: string; endTime: string; query?: string });
      case 'queryMetrics': return this.queryMetrics(call, parsedArguments.data as { service: string; metric: string; startTime: string; endTime: string });
      case 'searchRunbook': return this.searchRunbook(call, parsedArguments.data as { service: string; query: string });
      case 'getServiceTopology': return this.getServiceTopology(call, parsedArguments.data as { service: string });
    }
  }

  private queryLogs(call: ToolCall, input: { service: string; startTime: string; endTime: string; query?: string }): ToolResult {
    const scenario = findFixtureScenario(input.service);
    if (!scenario) return failure(call, 'UNKNOWN_SERVICE', `No fixture service named ${input.service}.`);
    const query = input.query ? lower(input.query) : undefined;
    const entries = scenario.logs.filter((entry) => inRange(entry.timestamp, input.startTime, input.endTime) && (!query || lower(`${entry.message} ${JSON.stringify(entry.attributes ?? {})}`).includes(query)));
    if (!entries.length) return failure(call, 'NO_MATCHING_DATA', 'No log entries matched the requested service, time range, and query.');
    const data = definitionFor('queryLogs').outputSchema.parse({ entries, count: entries.length });
    const noteworthy = entries.filter((entry) => entry.level === 'ERROR').map((entry) => entry.message).at(-1) ?? entries.at(-1)!.message;
    return { ok: true, callId: call.callId, name: call.name, data, summary: `${input.service}: ${noteworthy} (${entries.length} matching log entries).`, sourceUri: scenario.sourceUris.logs, timeRangeStart: input.startTime, timeRangeEnd: input.endTime };
  }

  private queryMetrics(call: ToolCall, input: { service: string; metric: string; startTime: string; endTime: string }): ToolResult {
    const scenario = findFixtureScenario(input.service);
    if (!scenario) return failure(call, 'UNKNOWN_SERVICE', `No fixture service named ${input.service}.`);
    const series = scenario.metrics.find((value) => value.metric === input.metric);
    if (!series) return failure(call, 'NO_MATCHING_DATA', `No ${input.metric} metric is available for ${input.service}.`);
    const samples = series.samples.filter((sample) => inRange(sample.timestamp, input.startTime, input.endTime));
    if (!samples.length) return failure(call, 'NO_MATCHING_DATA', 'No metric samples matched the requested time range.');
    const latest = samples.at(-1)!;
    const data = definitionFor('queryMetrics').outputSchema.parse({ metric: series.metric, unit: series.unit, samples });
    return { ok: true, callId: call.callId, name: call.name, data, summary: `${input.service} ${series.metric} was ${latest.value} ${series.unit} at ${latest.timestamp}.`, sourceUri: scenario.sourceUris.metrics, timeRangeStart: input.startTime, timeRangeEnd: input.endTime };
  }

  private searchRunbook(call: ToolCall, input: { service: string; query: string }): ToolResult {
    const scenario = findFixtureScenario(input.service);
    if (!scenario) return failure(call, 'UNKNOWN_SERVICE', `No fixture service named ${input.service}.`);
    const query = lower(input.query);
    const excerpts = scenario.runbook.markdown.split(/\n\s*\n/).filter((paragraph) => lower(paragraph).includes(query));
    if (!excerpts.length) return failure(call, 'NO_MATCHING_DATA', 'No runbook excerpt matched the requested query.');
    const data = definitionFor('searchRunbook').outputSchema.parse({ title: scenario.runbook.title, excerpts });
    return { ok: true, callId: call.callId, name: call.name, data, summary: `${scenario.runbook.title} returned ${excerpts.length} matching excerpt(s) for "${input.query}".`, sourceUri: scenario.runbook.sourceUri };
  }

  private getServiceTopology(call: ToolCall, input: { service: string }): ToolResult {
    const scenario = findFixtureScenario(input.service);
    if (!scenario) return failure(call, 'UNKNOWN_SERVICE', `No fixture service named ${input.service}.`);
    const data = definitionFor('getServiceTopology').outputSchema.parse(scenario.topology);
    return { ok: true, callId: call.callId, name: call.name, data, summary: `${input.service} has ${scenario.topology.upstream.length} upstream and ${scenario.topology.downstream.length} downstream dependency entries.`, sourceUri: scenario.sourceUris.topology };
  }
}

function definitionFor(name: ToolName): ToolDefinition {
  return toolDefinitions.find((definition) => definition.name === name)!;
}
