using Microsoft.EntityFrameworkCore;
using OpsPilot.Domain.Conversations;
using OpsPilot.Domain.Files;
using OpsPilot.Domain.Users;

namespace OpsPilot.Infrastructure.Persistence;

public sealed class OpsPilotDbContext(DbContextOptions<OpsPilotDbContext> options) : DbContext(options)
{
    public DbSet<Conversation> Conversations => Set<Conversation>();

    public DbSet<FileAsset> FileAssets => Set<FileAsset>();

    public DbSet<User> Users => Set<User>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        base.OnModelCreating(modelBuilder);
        modelBuilder.ApplyConfigurationsFromAssembly(typeof(OpsPilotDbContext).Assembly);
    }
}
