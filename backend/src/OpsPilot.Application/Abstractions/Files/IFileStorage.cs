namespace OpsPilot.Application.Abstractions.Files;

public interface IFileStorage
{
    Task<StoredFile> SaveAsync(
        string originalFileName,
        Stream content,
        CancellationToken cancellationToken);

    Task DeleteAsync(string storagePath, CancellationToken cancellationToken);
}
