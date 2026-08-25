using Microsoft.Extensions.Logging;
using OpsPilot.Application.Abstractions.Files;
using OpsPilot.Application.Abstractions.Persistence;
using OpsPilot.Application.Exceptions;
using OpsPilot.Domain.Files;

namespace OpsPilot.Application.Files.Upload;

public sealed class UploadFileHandler(
    IFileStorage fileStorage,
    IFileAssetRepository fileAssetRepository,
    TimeProvider timeProvider,
    ILogger<UploadFileHandler> logger)
{
    public async Task<UploadFileResult> HandleAsync(
        UploadFileCommand command,
        CancellationToken cancellationToken)
    {
        string safeFileName = Validate(command);
        DateTime createdAtUtc = timeProvider.GetUtcNow().UtcDateTime;
        StoredFile? storedFile = null;

        try
        {
            storedFile = await fileStorage.SaveAsync(
                safeFileName,
                command.Content,
                cancellationToken);

            FileAsset fileAsset;
            try
            {
                fileAsset = FileAsset.Create(
                    safeFileName,
                    storedFile.StoredFileName,
                    command.ContentType ?? string.Empty,
                    command.Length,
                    storedFile.StoragePath,
                    createdAtUtc);
            }
            catch (ArgumentException exception)
            {
                throw new ApplicationValidationException(exception.Message, exception);
            }

            await fileAssetRepository.AddAsync(fileAsset, cancellationToken);
            await fileAssetRepository.SaveChangesAsync(cancellationToken);

            return new UploadFileResult(
                fileAsset.Id,
                fileAsset.OriginalFileName,
                fileAsset.ContentType,
                fileAsset.SizeBytes,
                fileAsset.CreatedAtUtc);
        }
        catch (Exception) when (storedFile is not null)
        {
            try
            {
                await fileStorage.DeleteAsync(storedFile.StoragePath, CancellationToken.None);
            }
            catch (Exception cleanupException)
            {
                logger.LogError(
                    cleanupException,
                    "Failed to clean up stored file {StoragePath} after upload persistence failed.",
                    storedFile.StoragePath);
            }

            throw;
        }
    }

    private static string Validate(UploadFileCommand command)
    {
        if (command.Content is null)
        {
            throw new ApplicationValidationException("File content is required.");
        }

        string safeFileName = Path.GetFileName(command.FileName ?? string.Empty);
        if (string.IsNullOrWhiteSpace(safeFileName))
        {
            throw new ApplicationValidationException("File name is required.");
        }

        if (command.Length <= 0)
        {
            throw new ApplicationValidationException("The uploaded file cannot be empty.");
        }

        if (command.Length > UploadFileLimits.MaxFileSizeBytes)
        {
            throw new ApplicationValidationException(
                $"The uploaded file cannot exceed {UploadFileLimits.MaxFileSizeBytes / (1024 * 1024)} MB.");
        }

        if (!string.Equals(
                Path.GetExtension(safeFileName),
                UploadFileLimits.AllowedExtension,
                StringComparison.OrdinalIgnoreCase))
        {
            throw new ApplicationValidationException("Only .xlsx files are supported.");
        }

        if (safeFileName.Length > FileAsset.MaxOriginalFileNameLength)
        {
            throw new ApplicationValidationException(
                $"File name cannot exceed {FileAsset.MaxOriginalFileNameLength} characters.");
        }

        if ((command.ContentType ?? string.Empty).Length > FileAsset.MaxContentTypeLength)
        {
            throw new ApplicationValidationException(
                $"Content type cannot exceed {FileAsset.MaxContentTypeLength} characters.");
        }

        return safeFileName;
    }
}
