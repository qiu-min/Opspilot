using Microsoft.AspNetCore.Mvc;
using OpsPilot.Api.Features.Auth.Contracts.Requests;
using OpsPilot.Api.Features.Auth.Contracts.Responses;
using OpsPilot.Application.Exceptions;
using OpsPilot.Application.Users.Login;
using OpsPilot.Application.Users.Register;

namespace OpsPilot.Api.Features.Auth;

[ApiController]
[Route("api/auth")]
public sealed class AuthController(
    RegisterUserHandler registerUserHandler,
    LoginUserHandler loginUserHandler) : ControllerBase
{
    [HttpPost("register")]
    [ProducesResponseType(typeof(RegisterResponse), StatusCodes.Status201Created)]
    public async Task<ActionResult<RegisterResponse>> Register(
        RegisterRequest? request,
        CancellationToken cancellationToken)
    {
        if (request is null)
        {
            throw new ApplicationValidationException("Request body is required.");
        }

        RegisterUserResult result = await registerUserHandler.HandleAsync(
            new RegisterUserCommand(request.Email, request.Password),
            cancellationToken);

        var response = new RegisterResponse(
            result.Id,
            result.Email,
            result.CreatedAtUtc);

        return StatusCode(StatusCodes.Status201Created, response);
    }

    [HttpPost("login")]
    [ProducesResponseType(typeof(LoginResponse), StatusCodes.Status200OK)]
    public async Task<ActionResult<LoginResponse>> Login(
        LoginRequest? request,
        CancellationToken cancellationToken)
    {
        if (request is null)
        {
            throw new ApplicationValidationException("Request body is required.");
        }

        LoginUserResult result = await loginUserHandler.HandleAsync(
            new LoginUserCommand(request.Email, request.Password),
            cancellationToken);

        return Ok(new LoginResponse(
            result.UserId,
            result.Email,
            result.AccessToken,
            result.ExpiresAtUtc));
    }
}
