using OpsPilot.Application.Abstractions.Persistence;
using OpsPilot.Application.AnalysisTasks.Create;
using OpsPilot.Application.Exceptions;
using OpsPilot.Domain.AnalysisTasks;

namespace OpsPilot.UnitTests;

public sealed class CreateAnalysisTaskHandlerTests
{
    private static readonly DateTimeOffset CurrentTime =
        new(2026, 8, 25, 12, 0, 0, TimeSpan.Zero);

    [Fact]
    public async Task HandleAsync_CreatesPendingTaskAndPersistsIt()
    {
        var repository = new FakeAnalysisTaskRepository();
        var handler = new CreateAnalysisTaskHandler(
            repository,
            new FixedTimeProvider(CurrentTime));
        Guid fileId = Guid.NewGuid();
        using var cancellationSource = new CancellationTokenSource();

        CreateAnalysisTaskResult result = await handler.HandleAsync(
            new CreateAnalysisTaskCommand(fileId, "Analyze this file"),
            cancellationSource.Token);

        Assert.True(repository.WasAdded);
        Assert.True(repository.WasSaved);
        Assert.Equal(fileId, repository.AddedTask?.FileId);
        Assert.Equal(AnalysisTaskStatus.Pending, result.Status);
        Assert.Equal(CurrentTime.UtcDateTime, result.CreatedAtUtc);
        Assert.Equal(cancellationSource.Token, repository.AddToken);
        Assert.Equal(cancellationSource.Token, repository.SaveToken);
    }

    [Fact]
    public async Task HandleAsync_WhenDomainValidationFails_DoesNotPersist()
    {
        var repository = new FakeAnalysisTaskRepository();
        var handler = new CreateAnalysisTaskHandler(
            repository,
            new FixedTimeProvider(CurrentTime));

        await Assert.ThrowsAsync<ApplicationValidationException>(() =>
            handler.HandleAsync(
                new CreateAnalysisTaskCommand(Guid.Empty, "Analyze this file"),
                CancellationToken.None));

        Assert.False(repository.WasAdded);
        Assert.False(repository.WasSaved);
    }

    [Fact]
    public async Task HandleAsync_WhenPromptIsTooLong_DoesNotPersist()
    {
        var repository = new FakeAnalysisTaskRepository();
        var handler = new CreateAnalysisTaskHandler(
            repository,
            new FixedTimeProvider(CurrentTime));
        string prompt = new('a', AnalysisTask.MaxPromptLength + 1);

        await Assert.ThrowsAsync<ApplicationValidationException>(() =>
            handler.HandleAsync(
                new CreateAnalysisTaskCommand(Guid.NewGuid(), prompt),
                CancellationToken.None));

        Assert.False(repository.WasAdded);
        Assert.False(repository.WasSaved);
    }

    private sealed class FixedTimeProvider(DateTimeOffset currentTime) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow()
        {
            return currentTime;
        }
    }

    private sealed class FakeAnalysisTaskRepository : IAnalysisTaskRepository
    {
        public AnalysisTask? AddedTask { get; private set; }

        public CancellationToken AddToken { get; private set; }

        public CancellationToken SaveToken { get; private set; }

        public bool WasAdded { get; private set; }

        public bool WasSaved { get; private set; }

        public Task AddAsync(AnalysisTask analysisTask, CancellationToken cancellationToken)
        {
            AddedTask = analysisTask;
            AddToken = cancellationToken;
            WasAdded = true;
            return Task.CompletedTask;
        }

        public Task SaveChangesAsync(CancellationToken cancellationToken)
        {
            SaveToken = cancellationToken;
            WasSaved = true;
            return Task.CompletedTask;
        }
    }
}
