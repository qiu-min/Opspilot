using Microsoft.EntityFrameworkCore;
using OpsPilot.Domain.AgentRuns;
using OpsPilot.Domain.AnalysisTasks;
using OpsPilot.Domain.Files;
using OpsPilot.Domain.Users;

namespace OpsPilot.Infrastructure.Persistence;

public sealed class OpsPilotDbContext(DbContextOptions<OpsPilotDbContext> options) : DbContext(options)
{
    public DbSet<AnalysisTask> AnalysisTasks => Set<AnalysisTask>();

    public DbSet<AgentRun> AgentRuns => Set<AgentRun>();

    public DbSet<FileAsset> FileAssets => Set<FileAsset>();

    public DbSet<User> Users => Set<User>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        base.OnModelCreating(modelBuilder);
        modelBuilder.ApplyConfigurationsFromAssembly(typeof(OpsPilotDbContext).Assembly);
    }
}
