using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace OpsPilot.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class RefineConversationIndexes : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_conversations_updated_at_utc",
                table: "conversations");

            migrationBuilder.DropIndex(
                name: "IX_conversations_user_id",
                table: "conversations");

            migrationBuilder.CreateIndex(
                name: "IX_conversations_agent_session_id",
                table: "conversations",
                column: "agent_session_id",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_conversations_user_id_updated_at_utc",
                table: "conversations",
                columns: new[] { "user_id", "updated_at_utc" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_conversations_agent_session_id",
                table: "conversations");

            migrationBuilder.DropIndex(
                name: "IX_conversations_user_id_updated_at_utc",
                table: "conversations");

            migrationBuilder.CreateIndex(
                name: "IX_conversations_updated_at_utc",
                table: "conversations",
                column: "updated_at_utc");

            migrationBuilder.CreateIndex(
                name: "IX_conversations_user_id",
                table: "conversations",
                column: "user_id");
        }
    }
}
