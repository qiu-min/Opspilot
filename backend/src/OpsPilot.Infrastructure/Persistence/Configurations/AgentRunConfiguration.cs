using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using OpsPilot.Domain.AgentRuns;
using OpsPilot.Domain.AnalysisTasks;

namespace OpsPilot.Infrastructure.Persistence.Configurations;

public sealed class AgentRunConfiguration : IEntityTypeConfiguration<AgentRun>
{
    public void Configure(EntityTypeBuilder<AgentRun> builder)
    {
        builder.ToTable("agent_runs");

        builder.HasKey(agentRun => agentRun.Id);

        builder.Property(agentRun => agentRun.Id)
            .HasColumnName("id")
            .ValueGeneratedNever();

        builder.Property(agentRun => agentRun.AnalysisTaskId)
            .HasColumnName("analysis_task_id")
            .IsRequired();

        builder.Property(agentRun => agentRun.ExternalRunId)
            .HasColumnName("external_run_id")
            .HasMaxLength(256);

        builder.Property(agentRun => agentRun.Status)
            .HasColumnName("status")
            .HasConversion<string>()
            .HasMaxLength(32)
            .IsRequired();

        builder.Property(agentRun => agentRun.CreatedAtUtc)
            .HasColumnName("created_at_utc")
            .IsRequired();

        builder.Property(agentRun => agentRun.UpdatedAtUtc)
            .HasColumnName("updated_at_utc")
            .IsRequired();

        builder.Property(agentRun => agentRun.StartedAtUtc)
            .HasColumnName("started_at_utc");

        builder.Property(agentRun => agentRun.CompletedAtUtc)
            .HasColumnName("completed_at_utc");

        builder.HasIndex(agentRun => agentRun.AnalysisTaskId);
        builder.HasIndex(agentRun => agentRun.ExternalRunId);

        builder.HasOne<AnalysisTask>()
            .WithMany()
            .HasForeignKey(agentRun => agentRun.AnalysisTaskId)
            .OnDelete(DeleteBehavior.Restrict);
    }
}
