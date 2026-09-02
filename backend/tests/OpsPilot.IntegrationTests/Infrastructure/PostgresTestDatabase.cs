using Microsoft.EntityFrameworkCore;
using Npgsql;
using OpsPilot.Infrastructure.Persistence;

namespace OpsPilot.IntegrationTests.Infrastructure;

public sealed class PostgresTestDatabase : IDisposable
{
    private const string DatabasePrefix = "opspilot_test_";
    private const string AdminDatabaseName = "postgres";
    private bool _created;
    private bool _disposed;

    public PostgresTestDatabase()
    {
        DatabaseName = $"{DatabasePrefix}{Guid.NewGuid():N}";
        ConnectionString = BuildConnectionString(DatabaseName);
    }

    public string DatabaseName { get; }

    public string ConnectionString { get; }

    public void Initialize()
    {
        ThrowIfDisposed();

        if (_created)
        {
            return;
        }

        using NpgsqlConnection connection = new(BuildConnectionString(AdminDatabaseName));
        connection.Open();

        using NpgsqlCommand command = connection.CreateCommand();
        command.CommandText = $"CREATE DATABASE {QuoteDatabaseIdentifier(DatabaseName)}";
        command.ExecuteNonQuery();
        _created = true;
    }

    public void Migrate(OpsPilotDbContext dbContext)
    {
        ArgumentNullException.ThrowIfNull(dbContext);
        ThrowIfDisposed();

        if (!_created)
        {
            throw new InvalidOperationException("The PostgreSQL test database must be initialized before migration.");
        }

        dbContext.Database.Migrate();
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;

        try
        {
            DropDatabase();
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine($"Unable to drop PostgreSQL test database '{DatabaseName}': {exception.Message}");
        }
    }

    private void DropDatabase()
    {
        EnsureTestDatabaseName(DatabaseName);

        using NpgsqlConnection connection = new(BuildConnectionString(AdminDatabaseName));
        connection.Open();

        using NpgsqlCommand command = connection.CreateCommand();
        command.CommandText = $"DROP DATABASE IF EXISTS {QuoteDatabaseIdentifier(DatabaseName)} WITH (FORCE)";
        command.ExecuteNonQuery();
    }

    private static string BuildConnectionString(string databaseName)
    {
        NpgsqlConnectionStringBuilder builder = new()
        {
            Host = GetEnvironmentValue("POSTGRES_HOST", "localhost"),
            Port = GetPort(),
            Username = GetEnvironmentValue("POSTGRES_USER", "opspilot"),
            Password = GetEnvironmentValue("POSTGRES_PASSWORD", "opspilot_dev_password"),
            Database = databaseName,
        };

        return builder.ConnectionString;
    }

    private static string GetEnvironmentValue(string name, string defaultValue) =>
        string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable(name))
            ? defaultValue
            : Environment.GetEnvironmentVariable(name)!;

    private static int GetPort()
    {
        string? configuredPort = Environment.GetEnvironmentVariable("POSTGRES_PORT");
        return int.TryParse(configuredPort, out int port) && port is > 0 and <= 65535
            ? port
            : 5432;
    }

    private static string QuoteDatabaseIdentifier(string databaseName)
    {
        EnsureTestDatabaseName(databaseName);
        return $"\"{databaseName.Replace("\"", "\"\"", StringComparison.Ordinal)}\"";
    }

    private static void EnsureTestDatabaseName(string databaseName)
    {
        if (!databaseName.StartsWith(DatabasePrefix, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("Refusing to operate on a non-test PostgreSQL database.");
        }

        string suffix = databaseName[DatabasePrefix.Length..];
        if (suffix.Length != 32 || suffix.Any(character => !IsLowercaseHexDigit(character)))
        {
            throw new InvalidOperationException("The PostgreSQL test database name is not valid.");
        }
    }

    private static bool IsLowercaseHexDigit(char character) =>
        character is >= '0' and <= '9' or >= 'a' and <= 'f';

    private void ThrowIfDisposed()
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
    }
}
