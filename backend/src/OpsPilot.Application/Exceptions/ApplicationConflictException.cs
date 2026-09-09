namespace OpsPilot.Application.Exceptions;

public sealed class ApplicationConflictException : Exception
{
    public ApplicationConflictException(string message, string code = "CONFLICT")
        : base(message)
    {
        Code = code;
    }

    public ApplicationConflictException(string message, Exception innerException, string code = "CONFLICT")
        : base(message, innerException)
    {
        Code = code;
    }

    public string Code { get; }
}
