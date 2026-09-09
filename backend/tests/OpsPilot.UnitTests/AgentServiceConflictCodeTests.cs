using System.Net;
using System.Text;
using OpsPilot.Application.Exceptions;
using OpsPilot.Infrastructure.AgentService;

namespace OpsPilot.UnitTests;

public sealed class AgentServiceConflictCodeTests
{
    [Theory]
    [InlineData("TURN_STREAM_REPLAY_GAP")]
    [InlineData("SESSION_ACTIVE_TURN_CONFLICT")]
    public async Task Client_PreservesAgentServiceConflictCode(string code)
    {
        using var httpClient = new HttpClient(new ConflictHandler(code))
        {
            BaseAddress = new Uri("http://agent-service.test/"),
        };
        var client = new AgentServiceClient(httpClient);

        ApplicationConflictException exception = await Assert.ThrowsAsync<ApplicationConflictException>(
            () => client.GetActiveTurnAsync(Guid.NewGuid(), CancellationToken.None));

        Assert.Equal(code, exception.Code);
    }

    private sealed class ConflictHandler(string code) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
            Task.FromResult(new HttpResponseMessage(HttpStatusCode.Conflict)
            {
                Content = new StringContent(
                    $"{{\"code\":\"{code}\",\"message\":\"conflict\"}}",
                    Encoding.UTF8,
                    "application/json"),
            });
    }
}
