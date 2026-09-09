using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace OpsPilot.Infrastructure.Persistence.Migrations;

/// <summary>
/// Replaces the legacy Conversation ownership row with the single Agent Service Session identity.
/// Bound rows use agent_session_id as the new primary key. Empty legacy rows are intentionally
/// discarded because no Agent Service Session exists for them; this is safe for the disposable
/// development database convention used by this repository.
/// </summary>
public partial class MigrateConversationsToSessions : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.CreateTable(
            name: "sessions",
            columns: table => new
            {
                id = table.Column<Guid>(type: "uuid", nullable: false),
                user_id = table.Column<Guid>(type: "uuid", nullable: false),
                title = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                created_at_utc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                updated_at_utc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
            },
            constraints: table => table.PrimaryKey("PK_sessions", x => x.id));

        // Keep the real Agent Service identity for rows that were already bound.
        migrationBuilder.Sql("""
            INSERT INTO sessions (id, user_id, title, created_at_utc, updated_at_utc)
            SELECT agent_session_id, user_id, title, created_at_utc, updated_at_utc
            FROM conversations
            WHERE agent_session_id IS NOT NULL;
            """);
        migrationBuilder.DropTable(name: "conversations");
        migrationBuilder.CreateIndex(
            name: "IX_sessions_user_id_updated_at_utc",
            table: "sessions",
            columns: new[] { "user_id", "updated_at_utc" });
    }

    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropTable(name: "sessions");
        migrationBuilder.CreateTable(
            name: "conversations",
            columns: table => new
            {
                id = table.Column<Guid>(type: "uuid", nullable: false),
                agent_session_id = table.Column<Guid>(type: "uuid", nullable: true),
                user_id = table.Column<Guid>(type: "uuid", nullable: false),
                title = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                created_at_utc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                updated_at_utc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
            },
            constraints: table => table.PrimaryKey("PK_conversations", x => x.id));
        migrationBuilder.CreateIndex(name: "IX_conversations_agent_session_id", table: "conversations", column: "agent_session_id", unique: true);
        migrationBuilder.CreateIndex(name: "IX_conversations_user_id_updated_at_utc", table: "conversations", columns: new[] { "user_id", "updated_at_utc" });
    }
}
