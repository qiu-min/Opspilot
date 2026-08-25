using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;

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
        byte[] fileBytes = [80, 75, 3, 4, 1, 2, 3];
        using var form = new MultipartFormDataContent();
        using var fileContent = new ByteArrayContent(fileBytes);
        fileContent.Headers.ContentType = new MediaTypeHeaderValue(
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        form.Add(fileContent, "file", "monthly-report.XLSX");

        using HttpResponseMessage response = await httpClient.PostAsync("/api/files", form);

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);

        JsonElement body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.NotEqual(Guid.Empty, body.GetProperty("id").GetGuid());
        Assert.Equal("monthly-report.XLSX", body.GetProperty("fileName").GetString());
        Assert.Equal(fileBytes.LongLength, body.GetProperty("sizeBytes").GetInt64());
        Assert.False(body.TryGetProperty("storedFileName", out _));
        Assert.False(body.TryGetProperty("storagePath", out _));

        string[] storedFiles = Directory.GetFiles(
            factory.StorageRootPath,
            "*.xlsx",
            SearchOption.AllDirectories);
        string storedFilePath = Assert.Single(storedFiles);
        Assert.Equal(fileBytes, await File.ReadAllBytesAsync(storedFilePath));
    }
}

public sealed class FilesTestFactory : WebApplicationFactory<Program>
{
    public FilesTestFactory()
    {
        StorageRootPath = Path.Combine(
            Path.GetTempPath(),
            $"OpsPilot-file-tests-{Guid.NewGuid():N}");
    }

    public string StorageRootPath { get; }

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseSetting("FileStorage:RootPath", StorageRootPath);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing && Directory.Exists(StorageRootPath))
        {
            Directory.Delete(StorageRootPath, recursive: true);
        }

        base.Dispose(disposing);
    }
}
