const STORAGE_USERS_KEY = "portalUsers";
const STORAGE_CURRENT_USER_KEY = "portalCurrentUser";

function initLogin() {
  seedDefaultUsers();
  const linkInput = document.getElementById("portalLink");
  if (linkInput) {
    linkInput.value = window.location.href;
  }
}

function seedDefaultUsers() {
  const users = getStoredUsers();
  if (!users || users.length === 0) {
    const defaultAdmin = {
      username: "admin",
      password: "123",
      name: "Administrador",
      email: "admin@local",
      role: "admin",
      createdAt: new Date().toISOString(),
    };
    saveStoredUsers([defaultAdmin]);
  }
}

function getStoredUsers() {
  try {
    const raw = localStorage.getItem(STORAGE_USERS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveStoredUsers(users) {
  localStorage.setItem(STORAGE_USERS_KEY, JSON.stringify(users || []));
}

function findUser(username) {
  if (!username) return null;
  const users = getStoredUsers();
  return users.find(u => u.username.toLowerCase() === username.toLowerCase()) || null;
}

function copyPortalLink() {
  const linkInput = document.getElementById("portalLink");
  if (!linkInput) return;

  linkInput.select();
  linkInput.setSelectionRange(0, 99999);
  document.execCommand("copy");

  const originalText = linkInput.value;
  linkInput.value = "Copiado!";
  setTimeout(() => {
    linkInput.value = originalText;
  }, 1200);
}

function login(event) {
  event.preventDefault();

  const usuario = document.getElementById("usuario").value.trim();
  const senha = document.getElementById("senha").value.trim();
  const erroEl = document.getElementById("erro");
  const btnLogin = document.querySelector(".btn-login");

  erroEl.style.color = "#dc2626";
  erroEl.innerText = "";

  // Validações básicas
  if (!usuario || !senha) {
    erroEl.innerText = "⚠️ Preencha todos os campos";
    return;
  }

  if (usuario.length < 3) {
    erroEl.innerText = "⚠️ Usuário deve ter pelo menos 3 caracteres";
    return;
  }

  if (senha.length < 3) {
    erroEl.innerText = "⚠️ Senha deve ter pelo menos 3 caracteres";
    return;
  }

  // Desabilitar botão durante o login
  btnLogin.disabled = true;
  btnLogin.textContent = "Entrando...";

  setTimeout(() => {
    const user = findUser(usuario);

    if (!user) {
      erroEl.innerText = "❌ Usuário não encontrado. Cadastre-se para solicitar acesso.";
      btnLogin.disabled = false;
      btnLogin.textContent = "Entrar";
      return;
    }

    if (user.role === "pending") {
      erroEl.innerText = "⏳ Sua solicitação está pendente de aprovação. Aguarde.";
      btnLogin.disabled = false;
      btnLogin.textContent = "Entrar";
      return;
    }

    if (user.password !== senha) {
      erroEl.innerText = "❌ Usuário ou senha inválidos";
      btnLogin.disabled = false;
      btnLogin.textContent = "Entrar";
      document.getElementById("senha").value = "";
      document.getElementById("senha").focus();
      return;
    }

    // Login bem-sucedido
    localStorage.setItem(STORAGE_CURRENT_USER_KEY, user.username);

    erroEl.style.color = "#16a34a";
    erroEl.innerText = "✅ Bem-vindo! Redirecionando...";

    setTimeout(() => {
      window.location.href = "dashboard.html";
    }, 600);
  }, 600);
}

document.addEventListener("DOMContentLoaded", initLogin);
