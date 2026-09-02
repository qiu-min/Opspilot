using OpsPilot.Domain.Files;

namespace OpsPilot.UnitTests;

public sealed class FileAssetTests
{
    private static readonly Guid UserId =
        Guid.Parse("eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee");

    [Fact]
    public void Create_WithValidUserIdStoresOwner()
    {
        FileAsset fileAsset = CreateFileAsset(UserId);

        Assert.Equal(UserId, fileAsset.UserId);
    }

    [Fact]
    public void Create_WithEmptyUserIdRejects()
    {
        Assert.Throws<ArgumentException>(() => CreateFileAsset(Guid.Empty));
    }

    private static FileAsset CreateFileAsset(Guid userId)
    {
        return FileAsset.Create(
            userId,
            "report.xlsx",
            "stored-report.xlsx",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            1234,
            "uploads/stored-report.xlsx",
            new DateTime(2026, 8, 25, 12, 0, 0, DateTimeKind.Utc));
    }
}
