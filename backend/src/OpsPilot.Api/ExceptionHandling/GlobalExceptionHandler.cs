using Microsoft.AspNetCore.Diagnostics;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using OpsPilot.Application.Exceptions;

namespace OpsPilot.Api.ExceptionHandling;

public sealed class GlobalExceptionHandler(
    ILogger<GlobalExceptionHandler> logger,
    IProblemDetailsService problemDetailsService) : IExceptionHandler
{
    public async ValueTask<bool> TryHandleAsync(
        HttpContext httpContext,
        Exception exception,
        CancellationToken cancellationToken)
    {
        bool isValidationException = exception is ApplicationValidationException;
        int statusCode = isValidationException
            ? StatusCodes.Status400BadRequest
            : StatusCodes.Status500InternalServerError;

        if (isValidationException)
        {
            logger.LogWarning(
                exception,
                "Request validation failed for {RequestMethod} {RequestPath}",
                httpContext.Request.Method,
                httpContext.Request.Path);
        }
        else
        {
            logger.LogError(
                exception,
                "Unhandled exception while processing {RequestMethod} {RequestPath}",
                httpContext.Request.Method,
                httpContext.Request.Path);
        }

        httpContext.Response.StatusCode = statusCode;

        await problemDetailsService.WriteAsync(new ProblemDetailsContext
        {
            HttpContext = httpContext,
            ProblemDetails = new ProblemDetails
            {
                Status = statusCode,
                Title = isValidationException
                    ? "The request is invalid."
                    : "An unexpected error occurred."
            }
        });

        return true;
    }
}
