async function logout(event) {
  // Prevent page to refresh
  event.preventDefault();

  // Perform the Logout request
  await fetch("https://api.retrox.app/logout/", { method: "POST" })

  // Remove token and redirect to the home page
  localStorage.removeItem('token')
  window.location.href = `${window.location.origin}/index.html`
}