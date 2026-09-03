import { ConversationPage } from "./components/conversation-page";
import { useAuth } from "./features/auth/auth-provider";
import { LoginPage } from "./features/auth/login-page";

export default function App() {
  const { session } = useAuth();

  return session === null ? <LoginPage /> : <ConversationPage />;
}
