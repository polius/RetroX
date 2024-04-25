function onLoad() {
  // Get components
  const loginButton = document.getElementById('loginButton');
  const registerButton = document.getElementById('registerButton');
  const setupButton = document.getElementById('setupButton');
  const gamesButton = document.getElementById('gamesButton');
  const profileButton = document.getElementById('profileButton');
  const logoutButton = document.getElementById('logoutButton');

  // Check user session
  const expires = localStorage.getItem('expires')
  if (expires == null) {
    loginButton.style.display = 'block';
    registerButton.style.display = 'block';
  }
  else {
    profileButton.style.display = 'block';
    logoutButton.style.display = 'block';
    if (localStorage.getItem('google_client_id') == "null") setupButton.style.display = 'block';
    else gamesButton.style.display = 'block';
  }
}

onLoad()