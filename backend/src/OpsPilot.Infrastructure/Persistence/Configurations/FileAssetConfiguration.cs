using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using OpsPilot.Domain.Files;

namespace OpsPilot.Infrastructure.Persistence.Configurations;

public sealed class FileAssetConfiguration : IEntityTypeConfiguration<FileAsset>
{
    public void Configure(EntityTypeBuilder<FileAsset> builder)
    {
        builder.ToTable("file_assets");

        builder.HasKey(fileAsset => fileAsset.Id);

        builder.Property(fileAsset => fileAsset.Id)
            .HasColumnName("id")
            .ValueGeneratedNever();

        builder.Property(fileAsset => fileAsset.OriginalFileName)
            .HasColumnName("original_file_name")
            .HasMaxLength(FileAsset.MaxOriginalFileNameLength)
            .IsRequired();

        builder.Property(fileAsset => fileAsset.StoredFileName)
            .HasColumnName("stored_file_name")
            .HasMaxLength(FileAsset.MaxStoredFileNameLength)
            .IsRequired();

        builder.Property(fileAsset => fileAsset.ContentType)
            .HasColumnName("content_type")
            .HasMaxLength(FileAsset.MaxContentTypeLength)
            .IsRequired();

        builder.Property(fileAsset => fileAsset.SizeBytes)
            .HasColumnName("size_bytes")
            .IsRequired();

        builder.Property(fileAsset => fileAsset.StoragePath)
            .HasColumnName("storage_path")
            .HasMaxLength(FileAsset.MaxStoragePathLength)
            .IsRequired();

        builder.Property(fileAsset => fileAsset.CreatedAtUtc)
            .HasColumnName("created_at_utc")
            .IsRequired();

        builder.HasIndex(fileAsset => fileAsset.StoredFileName)
            .IsUnique();
        builder.HasIndex(fileAsset => fileAsset.CreatedAtUtc);
    }
}
