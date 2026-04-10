const STORAGE_USERS_KEY = "portalUsers";
const STORAGE_CURRENT_USER_KEY = "portalCurrentUser";

function initLogin() {
  // Local fallback para uso sem servidor.
  seedDefaultUsers();
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

  const useApi = window.location.protocol.startsWith("http");

  if (useApi) {
    fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: usuario, password: senha }),
      credentials: "include",
    })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(body.error || "Falha ao autenticar");
        }
        localStorage.setItem(STORAGE_CURRENT_USER_KEY, usuario);
        erroEl.style.color = "#16a34a";
        erroEl.innerText = "✅ Bem-vindo! Redirecionando...";
        setTimeout(() => {
          window.location.href = "dashboard.html";
        }, 600);
      })
      .catch((err) => {
        // Fallback para o modo local, se o servidor não respondeu.
        const user = findUser(usuario);
        if (!user) {
          erroEl.innerText = "❌ Usuário não encontrado. Cadastre-se para solicitar acesso.";
        } else if (user.role === "pending") {
          erroEl.innerText = "⏳ Sua solicitação está pendente de aprovação. Aguarde.";
        } else if (user.password !== senha) {
          erroEl.innerText = "❌ Usuário ou senha inválidos";
          document.getElementById("senha").value = "";
          document.getElementById("senha").focus();
        } else {
          localStorage.setItem(STORAGE_CURRENT_USER_KEY, user.username);
          erroEl.style.color = "#16a34a";
          erroEl.innerText = "✅ Bem-vindo! Redirecionando...";
          setTimeout(() => {
            window.location.href = "dashboard.html";
          }, 600);
        }
        btnLogin.disabled = false;
        btnLogin.textContent = "Entrar";
      });

    return;
  }

  // Fallback local (sem servidor)
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
