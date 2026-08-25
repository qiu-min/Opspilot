namespace OpsPilot.Application.Exceptions;

public sealed class ApplicationValidationException : Exception
{
    public ApplicationValidationException(string message, Exception innerException)
        : base(message, innerException)
    {
    }
}
