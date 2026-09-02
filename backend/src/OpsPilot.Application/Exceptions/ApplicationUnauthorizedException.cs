namespace OpsPilot.Application.Exceptions;

public sealed class ApplicationUnauthorizedException : Exception
{
    public ApplicationUnauthorizedException(string message)
        : base(message)
    {
    }
}
