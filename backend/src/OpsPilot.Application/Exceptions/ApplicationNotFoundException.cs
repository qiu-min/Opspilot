namespace OpsPilot.Application.Exceptions;

public sealed class ApplicationNotFoundException : Exception
{
    public ApplicationNotFoundException(string message)
        : base(message)
    {
    }
}
