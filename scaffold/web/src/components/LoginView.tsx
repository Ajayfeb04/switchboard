export function LoginView() {
  return (
    <div className="login-page">
      <div className="login-card">
        <div className="brand-badge">Switchboard</div>
        <h1>Shared Team Inbox</h1>
        <p className="muted">
          Sign in with your workspace identity provider to view customer conversations, claim
          threads, and send real-time replies.
        </p>
        <a className="btn btn-primary btn-lg" href="/auth/login">
          Sign in with Mock IdP
        </a>
      </div>
    </div>
  );
}
