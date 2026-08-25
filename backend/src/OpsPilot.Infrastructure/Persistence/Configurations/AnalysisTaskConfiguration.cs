using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using OpsPilot.Domain.AnalysisTasks;

namespace OpsPilot.Infrastructure.Persistence.Configurations;

public sealed class AnalysisTaskConfiguration : IEntityTypeConfiguration<AnalysisTask>
{
    public void Configure(EntityTypeBuilder<AnalysisTask> builder)
    {
        builder.ToTable("analysis_tasks");

        builder.HasKey(analysisTask => analysisTask.Id);

        builder.Property(analysisTask => analysisTask.Id)
            .HasColumnName("id")
            .ValueGeneratedNever();

        builder.Property(analysisTask => analysisTask.FileId)
            .HasColumnName("file_id")
            .IsRequired();

        builder.Property(analysisTask => analysisTask.Prompt)
            .HasColumnName("prompt")
            .HasMaxLength(AnalysisTask.MaxPromptLength)
            .IsRequired();

        builder.Property(analysisTask => analysisTask.Status)
            .HasColumnName("status")
            .HasConversion<string>()
            .HasMaxLength(32)
            .IsRequired();

        builder.Property(analysisTask => analysisTask.CreatedAtUtc)
            .HasColumnName("created_at_utc")
            .IsRequired();

        builder.Property(analysisTask => analysisTask.UpdatedAtUtc)
            .HasColumnName("updated_at_utc")
            .IsRequired();

        builder.Property(analysisTask => analysisTask.StartedAtUtc)
            .HasColumnName("started_at_utc");

        builder.Property(analysisTask => analysisTask.CompletedAtUtc)
            .HasColumnName("completed_at_utc");

        builder.HasIndex(analysisTask => analysisTask.Status);
        builder.HasIndex(analysisTask => analysisTask.CreatedAtUtc);
    }
}
