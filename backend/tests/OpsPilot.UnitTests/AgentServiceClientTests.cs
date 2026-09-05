using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using OpsPilot.Application.Abstractions.AgentService;
using OpsPilot.Infrastructure.AgentService;

namespace OpsPilot.UnitTests;

public sealed class AgentServiceClientTests
{
    [Fact]
    public async Task GetHistoryAsync_GetsSessionHistoryAndMapsResponse()
    {
        string? requestPath = null;
        string? requestMethod = null;
        var handler = new StubHttpMessageHandler((request, _) =>
        {
            requestMethod = request.Method.Method;
            requestPath = request.RequestUri?.PathAndQuery;
            return Task.FromResult(JsonResponse(new
            {
                leafId = "entry-2",
                items = new[]
                {
                    new
                    {
                        type = "message",
                        id = "entry-1",
                        role = "user",
                        text = "hello",
                        createdAt = "2026-09-05T08:00:00.000Z",
                    },
                    new
                    {
                        type = "message",
                        id = "entry-2",
                        role = "assistant",
                        text = "Hi.",
                        createdAt = "2026-09-05T08:00:01.000Z",
                    },
                },
            }));
        });
        using var httpClient = new HttpClient(handler)
        {
            BaseAddress = new Uri("http://agent-service.test/"),
        };
        var client = new AgentServiceClient(httpClient);
        Guid sessionId = Guid.Parse("11111111-1111-1111-1111-111111111111");

        AgentConversationHistory result = await client.GetHistoryAsync(
            sessionId,
            CancellationToken.None);

        Assert.Equal("GET", requestMethod);
        Assert.Equal($"/sessions/{sessionId:D}/history", requestPath);
        Assert.Equal("entry-2", result.LeafId);
        Assert.Collection(
            result.Items,
            item =>
            {
                Assert.Equal("entry-1", item.Id);
                Assert.Equal("user", item.Role);
                Assert.Equal("hello", item.Text);
            },
            item =>
            {
                Assert.Equal("entry-2", item.Id);
                Assert.Equal("assistant", item.Role);
                Assert.Equal("Hi.", item.Text);
            });
    }

    [Fact]
    public async Task RunTurnAsync_PostsExpectedRequestAndMapsResponse()
    {
        string? requestPath = null;
        string? requestMethod = null;
        string? requestBody = null;
        var handler = new StubHttpMessageHandler(async (request, cancellationToken) =>
        {
            requestMethod = request.Method.Method;
            requestPath = request.RequestUri?.PathAndQuery;
            requestBody = await request.Content!.ReadAsStringAsync(cancellationToken);
            return JsonResponse(new
            {
                sessionId = Guid.Parse("11111111-1111-1111-1111-111111111111"),
                leafId = "leaf-1",
                status = "completed",
                output = "Workbook inspected.",
            });
        });
        using var httpClient = new HttpClient(handler)
        {
            BaseAddress = new Uri("http://agent-service.test/"),
        };
        var client = new AgentServiceClient(httpClient);
        Guid sessionId = Guid.NewGuid();
        using var cancellationSource = new CancellationTokenSource();

        AgentConversationTurnResult result = await client.RunTurnAsync(
            new AgentConversationTurnRequest(
                sessionId,
                "Inspect the workbook.",
                new AgentExcelResource(
                    Guid.Parse("22222222-2222-2222-2222-222222222222"),
                    "uploads/report.xlsx")),
            cancellationSource.Token);

        Assert.Equal("POST", requestMethod);
        Assert.Equal("/conversations/turns", requestPath);
        Assert.NotNull(requestBody);
        using JsonDocument document = JsonDocument.Parse(requestBody!);
        JsonElement body = document.RootElement;
        Assert.Equal(sessionId, body.GetProperty("sessionId").GetGuid());
        Assert.Equal("Inspect the workbook.", body.GetProperty("message").GetString());
        JsonElement resource = body.GetProperty("excelResource");
        Assert.Equal("22222222-2222-2222-2222-222222222222", resource.GetProperty("id").GetString());
        Assert.Equal("uploads/report.xlsx", resource.GetProperty("storagePath").GetString());
        Assert.False(body.TryGetProperty("filePath", out _));
        Assert.False(body.TryGetProperty("physicalPath", out _));
        Assert.False(body.TryGetProperty("storageRoot", out _));
        Assert.Equal(
            Guid.Parse("11111111-1111-1111-1111-111111111111"),
            result.SessionId);
        Assert.Equal("leaf-1", result.LeafId);
        Assert.Equal("completed", result.Status);
        Assert.Equal("Workbook inspected.", result.Output);
    }

    [Fact]
    public async Task RunTurnAsync_WithoutResourceOmitsExcelResourceFromPayload()
    {
        string? requestBody = null;
        var handler = new StubHttpMessageHandler(async (request, cancellationToken) =>
        {
            requestBody = await request.Content!.ReadAsStringAsync(cancellationToken);
            return JsonResponse(new
            {
                sessionId = Guid.NewGuid(),
                leafId = (string?)null,
                status = "completed",
                output = "Hello.",
            });
        });
        using var httpClient = new HttpClient(handler)
        {
            BaseAddress = new Uri("http://agent-service.test/"),
        };
        var client = new AgentServiceClient(httpClient);

        await client.RunTurnAsync(
            new AgentConversationTurnRequest(null, "Hello.", null),
            CancellationToken.None);

        using JsonDocument document = JsonDocument.Parse(requestBody!);
        Assert.False(document.RootElement.TryGetProperty("excelResource", out _));
    }

    [Fact]
    public async Task RunTurnAsync_WhenAgentServiceReturnsFailureThrowsWithoutResponseBody()
    {
        const string sensitiveResponseBody = "provider secret and model output";
        var handler = new StubHttpMessageHandler((_, _) => Task.FromResult(
            new HttpResponseMessage(HttpStatusCode.BadRequest)
            {
                Content = new StringContent(sensitiveResponseBody),
            }));
        using var httpClient = new HttpClient(handler)
        {
            BaseAddress = new Uri("http://agent-service.test/"),
        };
        var client = new AgentServiceClient(httpClient);

        HttpRequestException exception = await Assert.ThrowsAsync<HttpRequestException>(() =>
            client.RunTurnAsync(
                new AgentConversationTurnRequest(null, "Hello.", null),
                CancellationToken.None));

        Assert.DoesNotContain(sensitiveResponseBody, exception.Message);
    }

    [Fact]
    public async Task RunTurnAsync_PropagatesCancellationToken()
    {
        using var cancellationSource = new CancellationTokenSource();
        var handler = new StubHttpMessageHandler((_, cancellationToken) =>
        {
            cancellationToken.ThrowIfCancellationRequested();
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK));
        });
        using var httpClient = new HttpClient(handler)
        {
            BaseAddress = new Uri("http://agent-service.test/"),
        };
        var client = new AgentServiceClient(httpClient);
        cancellationSource.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            client.RunTurnAsync(
                new AgentConversationTurnRequest(null, "Hello.", null),
                cancellationSource.Token));
    }

    [Fact]
    public async Task StreamTurnAsync_PostsStreamingRequestAndMapsProtocolEventsInOrder()
    {
        string? requestPath = null;
        string? requestMethod = null;
        string? requestBody = null;
        const string sessionId = "11111111-1111-1111-1111-111111111111";

        var handler = new StubHttpMessageHandler(async (request, cancellationToken) =>
        {
            requestMethod = request.Method.Method;
            requestPath = request.RequestUri?.PathAndQuery;
            requestBody = await request.Content!.ReadAsStringAsync(cancellationToken);
            return SseResponse(
                """
                event: session_ready
                data: {"type":"session_ready","sessionId":"11111111-1111-1111-1111-111111111111","created":
                data: true}

                event: agent_start
                data: {"type":"agent_start"}

                event: turn_start
                data: {"type":"turn_start"}

                event: message_start
                data: {"type":"message_start","message":{"role":"assistant"}}

                event: message_update
                data: {"type":"message_update","event":{"type":"thinking.delta","contentIndex":0,"delta":"plan"},"message":{}}

                event: message_update
                data: {"type":"message_update","event":{"type":"text.delta","contentIndex":0,"delta":"hello"},"message":{}}

                event: message_update
                data: {"type":"message_update","event":{"type":"tool-call.delta","contentIndex":1,"callId":"call-1","delta":"{\\\"query\\\":"},"message":{}}

                event: message_update
                data: {"type":"message_update","event":{"type":"tool-call.completed","contentIndex":1,"toolCall":{"callId":"call-1","name":"lookup","arguments":{"query":"hello"}}},"message":{}}

                event: message_update
                data: {"type":"message_update","event":{"type":"usage","usage":{"inputTokens":10,"outputTokens":4,"totalTokens":14}},"message":{}}

                event: message_end
                data: {"type":"message_end","message":{"role":"assistant"}}

                event: tool_execution_start
                data: {"type":"tool_execution_start","toolCall":{"callId":"call-1","name":"lookup","arguments":{"query":"hello"}}}

                event: tool_execution_end
                data: {"type":"tool_execution_end","toolCall":{"callId":"call-1","name":"lookup","arguments":{"query":"hello"}},"result":{"role":"tool","callId":"call-1","name":"lookup","content":[{"type":"text","text":"world"}],"details":{"durationMs":4},"isError":false}}

                event: turn_end
                data: {"type":"turn_end"}

                event: agent_end
                data: {"type":"agent_end"}

                event: compaction_start
                data: {"type":"compaction_start","reason":"threshold"}

                event: compaction_end
                data: {"type":"compaction_end","reason":"threshold","aborted":false,"willRetry":false,"errorMessage":null}

                event: session_settled
                data: {"type":"session_settled"}

                event: done
                data: {"sessionId":"11111111-1111-1111-1111-111111111111","leafId":"leaf-1","status":"completed"}

                """);
        });
        using var httpClient = new HttpClient(handler)
        {
            BaseAddress = new Uri("http://agent-service.test/"),
        };
        var client = new AgentServiceClient(httpClient);

        List<AgentServiceStreamEvent> events = await CollectAsync(
            client,
            new AgentConversationTurnRequest(null, "Hello.", null),
            CancellationToken.None);

        Assert.Equal("POST", requestMethod);
        Assert.Equal("/conversations/turns/stream", requestPath);
        using (JsonDocument requestDocument = JsonDocument.Parse(requestBody!))
        {
            Assert.False(requestDocument.RootElement.TryGetProperty("sessionId", out _));
            Assert.Equal("Hello.", requestDocument.RootElement.GetProperty("message").GetString());
        }

        Assert.Collection(
            events,
            item => Assert.Equal(new AgentServiceStreamEvent.SessionReady(
                Guid.Parse(sessionId),
                true), item),
            item => Assert.IsType<AgentServiceStreamEvent.AgentStarted>(item),
            item => Assert.IsType<AgentServiceStreamEvent.TurnStarted>(item),
            item => Assert.Equal(new AgentServiceStreamEvent.MessageStarted("assistant"), item),
            item => Assert.Equal(new AgentServiceStreamEvent.ThinkingDelta(0, "plan"), item),
            item => Assert.Equal(new AgentServiceStreamEvent.TextDelta(0, "hello"), item),
            item => Assert.Equal(new AgentServiceStreamEvent.ToolCallDelta(
                1,
                "call-1",
                "{\\\"query\\\":"), item),
            item => Assert.Equal(new AgentServiceStreamEvent.ToolCallCompleted(
                1,
                new AgentServiceToolCall("call-1", "lookup", "{\"query\":\"hello\"}")), item),
            item => Assert.Equal(new AgentServiceStreamEvent.Usage(10, 4, 14), item),
            item => Assert.Equal(new AgentServiceStreamEvent.MessageCompleted("assistant"), item),
            item => Assert.Equal(new AgentServiceStreamEvent.ToolExecutionStarted(
                new AgentServiceToolCall("call-1", "lookup", "{\"query\":\"hello\"}")), item),
            item =>
            {
                var completed = Assert.IsType<AgentServiceStreamEvent.ToolExecutionCompleted>(item);
                Assert.Equal(
                    new AgentServiceToolCall("call-1", "lookup", "{\"query\":\"hello\"}"),
                    completed.ToolCall);
                Assert.Equal("call-1", completed.Result.CallId);
                Assert.Equal("lookup", completed.Result.Name);
                Assert.Equal(["world"], completed.Result.TextContent);
                Assert.False(completed.Result.IsError);
                Assert.Equal("{\"durationMs\":4}", completed.Result.DetailsJson);
            },
            item => Assert.IsType<AgentServiceStreamEvent.TurnEnded>(item),
            item => Assert.IsType<AgentServiceStreamEvent.AgentEnded>(item),
            item => Assert.Equal(new AgentServiceStreamEvent.CompactionStarted("threshold"), item),
            item => Assert.Equal(new AgentServiceStreamEvent.CompactionCompleted(
                "threshold",
                false,
                false,
                null), item),
            item => Assert.IsType<AgentServiceStreamEvent.SessionSettled>(item),
            item => Assert.Equal(new AgentServiceStreamEvent.Done(
                Guid.Parse(sessionId),
                "leaf-1",
                "completed"), item));
    }

    [Fact]
    public async Task StreamTurnAsync_MapsUnknownEventsAndContinuesToDone()
    {
        const string unknownOuterData = "{\"type\":\"retry_start\",\"attempt\":1}";
        const string unknownNestedData = "{\"type\":\"message_update\",\"event\":{\"type\":\"retry.delta\"},\"message\":{}}";
        var handler = new StubHttpMessageHandler((_, _) => Task.FromResult(
            SseResponse(
                "event: retry_start\ndata: " + unknownOuterData + "\n\n" +
                "event: message_update\ndata: " + unknownNestedData + "\n\n" +
                "event: done\ndata: {\"sessionId\":\"11111111-1111-1111-1111-111111111111\",\"leafId\":null,\"status\":\"error\"}\n\n")));
        using var httpClient = new HttpClient(handler)
        {
            BaseAddress = new Uri("http://agent-service.test/"),
        };
        var client = new AgentServiceClient(httpClient);

        List<AgentServiceStreamEvent> events = await CollectAsync(
            client,
            new AgentConversationTurnRequest(null, "Hello.", null),
            CancellationToken.None);

        Assert.Equal(new AgentServiceStreamEvent.Unknown(
            "retry_start",
            null,
            unknownOuterData), events[0]);
        Assert.Equal(new AgentServiceStreamEvent.Unknown(
            "message_update",
            "retry.delta",
            unknownNestedData), events[1]);
        Assert.Equal(new AgentServiceStreamEvent.Done(
            Guid.Parse("11111111-1111-1111-1111-111111111111"),
            null,
            "error"), events[2]);
    }

    [Fact]
    public async Task StreamTurnAsync_MapsTerminalErrorWithoutAppendingDone()
    {
        var handler = new StubHttpMessageHandler((_, _) => Task.FromResult(
            SseResponse("""
                event: error
                data: {"type":"error","message":"transport failed"}
                """)));
        using var httpClient = new HttpClient(handler)
        {
            BaseAddress = new Uri("http://agent-service.test/"),
        };
        var client = new AgentServiceClient(httpClient);

        List<AgentServiceStreamEvent> events = await CollectAsync(
            client,
            new AgentConversationTurnRequest(null, "Hello.", null),
            CancellationToken.None);

        Assert.Single(events);
        Assert.Equal(new AgentServiceStreamEvent.Error("transport failed"), events[0]);
    }

    [Fact]
    public async Task StreamTurnAsync_PreservesWhitespaceContentStrings()
    {
        var handler = new StubHttpMessageHandler((_, _) => Task.FromResult(
            SseResponse("""
                event: message_update
                data: {"type":"message_update","event":{"type":"text.delta","contentIndex":0,"delta":" "},"message":{}}

                event: message_update
                data: {"type":"message_update","event":{"type":"thinking.delta","contentIndex":0,"delta":"\n"},"message":{}}

                event: message_update
                data: {"type":"message_update","event":{"type":"tool-call.delta","contentIndex":1,"callId":"call-1","delta":" "},"message":{}}

                event: tool_execution_end
                data: {"type":"tool_execution_end","toolCall":{"callId":"call-1","name":"lookup","arguments":{}},"result":{"role":"tool","callId":"call-1","name":"lookup","content":[{"type":"text","text":" "},{"type":"text","text":""}],"isError":false}}

                """)));
        using var httpClient = new HttpClient(handler)
        {
            BaseAddress = new Uri("http://agent-service.test/"),
        };
        var client = new AgentServiceClient(httpClient);

        List<AgentServiceStreamEvent> events = await CollectAsync(
            client,
            new AgentConversationTurnRequest(null, "Hello.", null),
            CancellationToken.None);

        Assert.Equal(new AgentServiceStreamEvent.TextDelta(0, " "), events[0]);
        Assert.Equal(new AgentServiceStreamEvent.ThinkingDelta(0, "\n"), events[1]);
        Assert.Equal(new AgentServiceStreamEvent.ToolCallDelta(1, "call-1", " "), events[2]);

        var toolExecution = Assert.IsType<AgentServiceStreamEvent.ToolExecutionCompleted>(events[3]);
        Assert.Equal([" ", ""], toolExecution.Result.TextContent);
    }

    [Fact]
    public async Task StreamTurnAsync_RejectsWhitespaceToolIdentifier()
    {
        var handler = new StubHttpMessageHandler((_, _) => Task.FromResult(
            SseResponse("""
                event: tool_execution_start
                data: {"type":"tool_execution_start","toolCall":{"callId":"call-1","name":" ","arguments":{}}}

                """)));
        using var httpClient = new HttpClient(handler)
        {
            BaseAddress = new Uri("http://agent-service.test/"),
        };
        var client = new AgentServiceClient(httpClient);

        InvalidDataException exception = await Assert.ThrowsAsync<InvalidDataException>(() =>
            CollectAsync(
                client,
                new AgentConversationTurnRequest(null, "Hello.", null),
                CancellationToken.None));

        Assert.Contains("name", exception.Message);
    }

    [Fact]
    public async Task StreamTurnAsync_ThrowsInvalidDataExceptionForMalformedKnownEvent()
    {
        var handler = new StubHttpMessageHandler((_, _) => Task.FromResult(
            SseResponse("""
                event: session_ready
                data: {"type":"session_ready","created":true}

                """)));
        using var httpClient = new HttpClient(handler)
        {
            BaseAddress = new Uri("http://agent-service.test/"),
        };
        var client = new AgentServiceClient(httpClient);

        InvalidDataException exception = await Assert.ThrowsAsync<InvalidDataException>(() =>
            CollectAsync(
                client,
                new AgentConversationTurnRequest(null, "Hello.", null),
                CancellationToken.None));

        Assert.Contains("sessionId", exception.Message);
        Assert.Contains("session_ready", exception.Message);
    }

    [Fact]
    public async Task StreamTurnAsync_UsesResponseHeadersReadAndDoesNotWaitForEntireBody()
    {
        var readStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseRead = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var handler = new StubHttpMessageHandler((_, _) => Task.FromResult(
            new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new GatedStreamContent(
                    new GatedReadStream(
                        Encoding.UTF8.GetBytes(
                            "event: agent_start\ndata: {\"type\":\"agent_start\"}\n\n"),
                        readStarted,
                        releaseRead)),
            }));
        using var httpClient = new HttpClient(handler)
        {
            BaseAddress = new Uri("http://agent-service.test/"),
        };
        var client = new AgentServiceClient(httpClient);
        await using IAsyncEnumerator<AgentServiceStreamEvent> enumerator = client
            .StreamTurnAsync(
                new AgentConversationTurnRequest(null, "Hello.", null),
                CancellationToken.None)
            .GetAsyncEnumerator();

        ValueTask<bool> moveNext = enumerator.MoveNextAsync();
        await readStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.False(moveNext.IsCompleted);

        releaseRead.SetResult();
        Assert.True(await moveNext);
        Assert.IsType<AgentServiceStreamEvent.AgentStarted>(enumerator.Current);
    }

    [Fact]
    public async Task StreamTurnAsync_PropagatesCancellationDuringEnumeration()
    {
        using var cancellationSource = new CancellationTokenSource();
        var handler = new StubHttpMessageHandler((_, cancellationToken) =>
        {
            cancellationToken.ThrowIfCancellationRequested();
            return Task.FromResult(SseResponse(""));
        });
        using var httpClient = new HttpClient(handler)
        {
            BaseAddress = new Uri("http://agent-service.test/"),
        };
        var client = new AgentServiceClient(httpClient);
        cancellationSource.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            CollectAsync(
                client,
                new AgentConversationTurnRequest(null, "Hello.", null),
                cancellationSource.Token));
    }

    [Fact]
    public async Task StreamTurnAsync_WhenAgentServiceReturnsFailureThrowsWithoutResponseBody()
    {
        const string sensitiveResponseBody = "provider secret and model output";
        var handler = new StubHttpMessageHandler((_, _) => Task.FromResult(
            new HttpResponseMessage(HttpStatusCode.BadRequest)
            {
                Content = new StringContent(sensitiveResponseBody),
            }));
        using var httpClient = new HttpClient(handler)
        {
            BaseAddress = new Uri("http://agent-service.test/"),
        };
        var client = new AgentServiceClient(httpClient);

        HttpRequestException exception = await Assert.ThrowsAsync<HttpRequestException>(() =>
            CollectAsync(
                client,
                new AgentConversationTurnRequest(null, "Hello.", null),
                CancellationToken.None));

        Assert.DoesNotContain(sensitiveResponseBody, exception.Message);
    }

    private static async Task<List<AgentServiceStreamEvent>> CollectAsync(
        AgentServiceClient client,
        AgentConversationTurnRequest request,
        CancellationToken cancellationToken)
    {
        var events = new List<AgentServiceStreamEvent>();
        await foreach (AgentServiceStreamEvent streamEvent in client.StreamTurnAsync(
            request,
            cancellationToken))
        {
            events.Add(streamEvent);
        }

        return events;
    }

    private static HttpResponseMessage JsonResponse<T>(T value)
    {
        return new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = JsonContent.Create(value),
        };
    }

    private static HttpResponseMessage SseResponse(string body)
    {
        return new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(body, Encoding.UTF8, "text/event-stream"),
        };
    }

    private sealed class StubHttpMessageHandler(
        Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> send)
        : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            return send(request, cancellationToken);
        }
    }

    private sealed class GatedStreamContent(Stream stream) : HttpContent
    {
        protected override Task SerializeToStreamAsync(
            Stream target,
            TransportContext? context)
        {
            throw new NotSupportedException();
        }

        protected override bool TryComputeLength(out long length)
        {
            length = -1;
            return false;
        }

        protected override Task<Stream> CreateContentReadStreamAsync() =>
            Task.FromResult(stream);
    }

    private sealed class GatedReadStream(
        byte[] content,
        TaskCompletionSource readStarted,
        TaskCompletionSource releaseRead) : Stream
    {
        private int position;

        public override bool CanRead => true;

        public override bool CanSeek => false;

        public override bool CanWrite => false;

        public override long Length => content.Length;

        public override long Position
        {
            get => position;
            set => throw new NotSupportedException();
        }

        public override void Flush() => throw new NotSupportedException();

        public override int Read(byte[] buffer, int offset, int count) =>
            throw new NotSupportedException();

        public override long Seek(long offset, SeekOrigin origin) =>
            throw new NotSupportedException();

        public override void SetLength(long value) => throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count) =>
            throw new NotSupportedException();

        public override async ValueTask<int> ReadAsync(
            Memory<byte> buffer,
            CancellationToken cancellationToken = default)
        {
            readStarted.TrySetResult();
            await releaseRead.Task.WaitAsync(cancellationToken);
            if (position >= content.Length) return 0;

            int count = Math.Min(buffer.Length, content.Length - position);
            content.AsMemory(position, count).CopyTo(buffer);
            position += count;
            return count;
        }

        public override Task<int> ReadAsync(
            byte[] buffer,
            int offset,
            int count,
            CancellationToken cancellationToken) =>
            ReadAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();
    }
}
