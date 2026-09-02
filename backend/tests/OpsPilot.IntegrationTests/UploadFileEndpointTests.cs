using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using OpsPilot.Api.Features.Auth.Contracts.Responses;
using OpsPilot.Infrastructure.Persistence;
using OpsPilot.IntegrationTests.Infrastructure;

namespace OpsPilot.IntegrationTests;

public sealed class UploadFileEndpointTests : IClassFixture<FilesTestFactory>
{
    private readonly FilesTestFactory factory;
    private readonly HttpClient httpClient;

    public UploadFileEndpointTests(FilesTestFactory factory)
    {
        this.factory = factory;
        httpClient = factory.CreateClient();
    }

    [Fact]
    public async Task PostFile_WithXlsxMultipartContent_ReturnsCreatedAndStoresFile()
    {
        LoginResponse login = await RegisterAndLoginAsync();
        byte[] fileBytes = [80, 75, 3, 4, 1, 2, 3];
        using var form = new MultipartFormDataContent();
        using var fileContent = new ByteArrayContent(fileBytes);
        fileContent.Headers.ContentType = new MediaTypeHeaderValue(
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        form.Add(fileContent, "file", "monthly-report.XLSX");

        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/files")
        {
            Content = form
        };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", login.AccessToken);

        using HttpResponseMessage response = await httpClient.SendAsync(request);

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);

        JsonElement body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Guid fileAssetId = body.GetProperty("id").GetGuid();
        Assert.NotEqual(Guid.Empty, fileAssetId);
        Assert.Equal("monthly-report.XLSX", body.GetProperty("fileName").GetString());
        Assert.Equal(fileBytes.LongLength, body.GetProperty("sizeBytes").GetInt64());
        Assert.False(body.TryGetProperty("storedFileName", out _));
        Assert.False(body.TryGetProperty("storagePath", out _));

        await using AsyncServiceScope scope = factory.Services.CreateAsyncScope();
        OpsPilot.Domain.Files.FileAsset fileAsset = await scope.ServiceProvider
            .GetRequiredService<OpsPilotDbContext>()
            .FileAssets
            .SingleAsync(asset => asset.Id == fileAssetId);

        Assert.Equal("monthly-report.XLSX", fileAsset.OriginalFileName);
        Assert.Equal(login.UserId, fileAsset.UserId);
        Assert.EndsWith(".XLSX", fileAsset.StoredFileName, StringComparison.Ordinal);
        Assert.Equal($"uploads/{fileAsset.StoredFileName}", fileAsset.StoragePath);
        Assert.Equal(fileBytes.LongLength, fileAsset.SizeBytes);

        string[] storedFiles = Directory.GetFiles(
            factory.StorageRootPath,
            "*",
            SearchOption.AllDirectories);
        string storedFilePath = Assert.Single(storedFiles);
        Assert.Equal(
            Path.GetFullPath(Path.Combine(
                factory.StorageRootPath,
                fileAsset.StoragePath.Replace('/', Path.DirectorySeparatorChar))),
            Path.GetFullPath(storedFilePath));
        Assert.Equal(fileBytes, await File.ReadAllBytesAsync(storedFilePath));
    }

    [Fact]
    public async Task PostFile_WithoutAuthenticationReturnsUnauthorized()
    {
        byte[] fileBytes = [80, 75, 3, 4];
        using var form = new MultipartFormDataContent();
        using var fileContent = new ByteArrayContent(fileBytes);
        fileContent.Headers.ContentType = new MediaTypeHeaderValue(
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        form.Add(fileContent, "file", "anonymous.xlsx");

        using HttpResponseMessage response = await httpClient.PostAsync("/api/files", form);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    private async Task<LoginResponse> RegisterAndLoginAsync()
    {
        string email = $"file-test-{Guid.NewGuid():N}@example.com";
        const string password = "Password123!";

        using HttpResponseMessage registerResponse = await httpClient.PostAsJsonAsync(
            "/api/auth/register",
            new { email, password });
        Assert.Equal(HttpStatusCode.Created, registerResponse.StatusCode);

        using HttpResponseMessage loginResponse = await httpClient.PostAsJsonAsync(
            "/api/auth/login",
            new { email, password });
        Assert.Equal(HttpStatusCode.OK, loginResponse.StatusCode);

        return (await loginResponse.Content.ReadFromJsonAsync<LoginResponse>())!;
    }
}

public class FilesTestFactory : WebApplicationFactory<Program>
{
    private readonly PostgresTestDatabase _postgresDatabase = new();

    public FilesTestFactory()
    {
        StorageRootPath = Path.Combine(
            Path.GetTempPath(),
            $"OpsPilot-file-tests-{Guid.NewGuid():N}");
    }

    public string StorageRootPath { get; }

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Testing");
        builder.UseSetting("ConnectionStrings:Postgres", _postgresDatabase.ConnectionString);
        builder.UseSetting("AgentService:BaseUrl", "http://127.0.0.1:3000");
        builder.UseSetting("Jwt:SigningKey", TestJwtConfiguration.SigningKey);
        builder.UseSetting("FileStorage:RootPath", StorageRootPath);
        builder.ConfigureLogging(logging =>
        {
            logging.ClearProviders();
            logging.AddConsole();
        });
    }

    protected override IHost CreateHost(IHostBuilder builder)
    {
        _postgresDatabase.Initialize();
        IHost host = base.CreateHost(builder);

        using IServiceScope scope = host.Services.CreateScope();
        OpsPilotDbContext dbContext = scope.ServiceProvider
            .GetRequiredService<OpsPilotDbContext>();
        _postgresDatabase.Migrate(dbContext);

        return host;
    }

    protected override void Dispose(bool disposing)
    {
        try
        {
            base.Dispose(disposing);
        }
        finally
        {
            if (disposing)
            {
                _postgresDatabase.Dispose();

                try
                {
                    if (Directory.Exists(StorageRootPath))
                    {
                        Directory.Delete(StorageRootPath, recursive: true);
                    }
                }
                catch (Exception exception)
                {
                    Console.Error.WriteLine($"Unable to remove temporary file-test storage '{StorageRootPath}': {exception.Message}");
                }
            }
        }
    }
}
