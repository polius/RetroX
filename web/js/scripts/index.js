function onLoad() {
  // Get components
  const login = document.getElementById('login');
  const register = document.getElementById('register');
  const games = document.getElementById('games');
  const profile = document.getElementById('profile');
  const logout = document.getElementById('logout');

  // Check user session
  const expires = localStorage.getItem('expires')
  if (expires == null) {
    login.style.display = 'block';
    register.style.display = 'block';
  }
  else {
    games.style.display = 'block';
    profile.style.display = 'block';
    logout.style.display = 'block';
  }
  console.log(window.location)
}

onLoad()