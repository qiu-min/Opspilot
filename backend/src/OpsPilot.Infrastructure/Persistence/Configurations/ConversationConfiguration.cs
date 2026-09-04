using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using OpsPilot.Domain.Conversations;

namespace OpsPilot.Infrastructure.Persistence.Configurations;

public sealed class ConversationConfiguration : IEntityTypeConfiguration<Conversation>
{
    public void Configure(EntityTypeBuilder<Conversation> builder)
    {
        builder.ToTable("conversations");

        builder.HasKey(conversation => conversation.Id);

        builder.Property(conversation => conversation.Id)
            .HasColumnName("id")
            .ValueGeneratedNever();

        builder.Property(conversation => conversation.UserId)
            .HasColumnName("user_id")
            .IsRequired();

        builder.Property(conversation => conversation.AgentSessionId)
            .HasColumnName("agent_session_id");

        builder.Property(conversation => conversation.Title)
            .HasColumnName("title")
            .HasMaxLength(Conversation.MaxTitleLength)
            .IsRequired();

        builder.Property(conversation => conversation.CreatedAtUtc)
            .HasColumnName("created_at_utc")
            .IsRequired();

        builder.Property(conversation => conversation.UpdatedAtUtc)
            .HasColumnName("updated_at_utc")
            .IsRequired();

        builder.HasIndex(conversation => conversation.AgentSessionId)
            .IsUnique();

        builder.HasIndex(conversation => new
        {
            conversation.UserId,
            conversation.UpdatedAtUtc,
        });
    }
}
