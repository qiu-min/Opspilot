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
        bool isUnauthorizedException = exception is ApplicationUnauthorizedException;
        bool isConflictException = exception is ApplicationConflictException;
        bool isNotFoundException = exception is ApplicationNotFoundException;
        bool isSafeBusinessException =
            isValidationException
            || isUnauthorizedException
            || isConflictException
            || isNotFoundException;
        int statusCode =
            isValidationException
                ? StatusCodes.Status400BadRequest
                : isUnauthorizedException
                    ? StatusCodes.Status401Unauthorized
                    : isConflictException
                        ? StatusCodes.Status409Conflict
                        : isNotFoundException
                            ? StatusCodes.Status404NotFound
                            : StatusCodes.Status500InternalServerError;

        if (isSafeBusinessException)
        {
            logger.LogWarning(
                exception,
                "Request failed with a business error for {RequestMethod} {RequestPath}",
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
                Title =
                    isValidationException
                        ? "The request is invalid."
                        : isUnauthorizedException
                            ? "Authentication failed."
                            : isConflictException
                                ? "The request conflicts with existing data."
                                : isNotFoundException
                                    ? "The requested resource was not found."
                                    : "An unexpected error occurred.",
                Detail = isSafeBusinessException ? exception.Message : null
            }
        });

        return true;
    }
}
