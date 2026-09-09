using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using OpsPilot.Domain.Sessions;

namespace OpsPilot.Infrastructure.Persistence.Configurations;

public sealed class SessionConfiguration : IEntityTypeConfiguration<Session>
{
    public void Configure(EntityTypeBuilder<Session> builder)
    {
        builder.ToTable("sessions");
        builder.HasKey(session => session.Id);
        builder.Property(session => session.Id).HasColumnName("id").ValueGeneratedNever();
        builder.Property(session => session.UserId).HasColumnName("user_id").IsRequired();
        builder.Property(session => session.Title).HasColumnName("title").HasMaxLength(Session.MaxTitleLength).IsRequired();
        builder.Property(session => session.CreatedAtUtc).HasColumnName("created_at_utc").IsRequired();
        builder.Property(session => session.UpdatedAtUtc).HasColumnName("updated_at_utc").IsRequired();
        builder.HasIndex(session => new { session.UserId, session.UpdatedAtUtc });
    }
}
