using OpsPilot.Domain.Users;

namespace OpsPilot.Application.Abstractions.Security;

public interface IAccessTokenProvider
{
    AccessTokenResult Create(User user);
}
