async function logout(event) {
  // Prevent page to refresh
  event.preventDefault();

  // Perform the Logout request
  await fetch("https://api.retrox.app/logout/", { method: "POST" })

  // Remove session variables and redirect to the home page
  localStorage.removeItem('token')
  localStorage.removeItem('email')
  localStorage.removeItem('2fa')
  window.location.href = `${window.location.origin}/index.html`
}