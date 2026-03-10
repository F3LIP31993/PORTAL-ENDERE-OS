"""Servir o portal como uma aplicação web mais profissional usando Flask.

Esse servidor fornece:
- Autenticação simples (login/senha) com sessão via cookie.
- Persistência em SQLite para usuários (admin + pendentes).
- Endpoints para gerenciar solicitações de acesso (aprovar/rejeitar).
- Serviço estático para os arquivos do portal (HTML/CSS/JS).

Uso:
  python -m venv venv
  venv\\Scripts\\activate  # Windows
  # (ou: source venv/bin/activate no Linux/macOS)
  pip install -r requirements.txt
  python app.py

Depois acesse: http://localhost:5000/login.html
"""

import io
import os
import datetime
import smtplib
import ssl
from email.message import EmailMessage
from functools import wraps

from flask import Flask, request, jsonify, session, redirect, send_from_directory, send_file
from flask_cors import CORS
from flask_sqlalchemy import SQLAlchemy
from werkzeug.utils import secure_filename

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

app = Flask(__name__, static_folder=BASE_DIR, static_url_path="")
app.secret_key = os.environ.get("PORTAL_SECRET_KEY", "troque-essa-chave")
CORS(app, supports_credentials=True)

# Use DATABASE_URL para PostgreSQL (ou outro DB compatível com SQLAlchemy).
# Exemplo: postgresql://user:pass@localhost:5432/portal
DATABASE_URL = os.environ.get("DATABASE_URL")
if not DATABASE_URL:
    DATABASE_URL = f"sqlite:///{os.path.join(BASE_DIR, 'portal.db')}"

app.config["SQLALCHEMY_DATABASE_URI"] = DATABASE_URL
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False

# Email / SMTP configuration (optionally set via environment variables)
SMTP_HOST = os.environ.get("SMTP_HOST")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "587"))
SMTP_USER = os.environ.get("SMTP_USER")
SMTP_PASS = os.environ.get("SMTP_PASS")
SMTP_FROM = os.environ.get("SMTP_FROM") or "no-reply@portal.local"
ADMIN_EMAIL = os.environ.get("ADMIN_EMAIL") or "mauro.faria@claro.com.br"

# Se ADMIN_EMAIL estiver vazio, não iremos enviar notificações por e-mail.
SEND_EMAILS = bool(SMTP_HOST and SMTP_USER and SMTP_PASS and ADMIN_EMAIL)


def send_admin_email(subject: str, body: str):
    if not SEND_EMAILS:
        app.logger.debug("SMTP não configurado - pulando envio de email")
        return

    try:
        msg = EmailMessage()
        msg["Subject"] = subject
        msg["From"] = SMTP_FROM
        msg["To"] = ADMIN_EMAIL
        msg.set_content(body)

        context = ssl.create_default_context()
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=10) as server:
            server.starttls(context=context)
            server.login(SMTP_USER, SMTP_PASS)
            server.send_message(msg)

        app.logger.info("Notificação enviada por email para %s", ADMIN_EMAIL)
    except Exception as e:
        app.logger.warning("Falha ao enviar email de notificação: %s", e)


db = SQLAlchemy(app)


class User(db.Model):
    __tablename__ = "users"

    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String, unique=True, nullable=False)
    password = db.Column(db.String, nullable=False)
    name = db.Column(db.String, nullable=False)
    email = db.Column(db.String, nullable=False)
    role = db.Column(db.String, nullable=False)
    created_at = db.Column(db.DateTime, nullable=False, default=datetime.datetime.utcnow)
    approved_at = db.Column(db.DateTime, nullable=True)


class PendenteNote(db.Model):
    __tablename__ = "pendente_notes"

    id = db.Column(db.Integer, primary_key=True)
    cod_mdugo = db.Column(db.String, nullable=False, index=True)
    note = db.Column(db.Text, nullable=False)
    created_by = db.Column(db.String, nullable=False)
    created_at = db.Column(db.DateTime, nullable=False, default=datetime.datetime.utcnow)


class PendenteAttachment(db.Model):
    __tablename__ = "pendente_attachments"

    id = db.Column(db.Integer, primary_key=True)
    cod_mdugo = db.Column(db.String, nullable=False, index=True)
    filename = db.Column(db.String, nullable=False)
    content_type = db.Column(db.String, nullable=True)
    data = db.Column(db.LargeBinary, nullable=False)
    created_by = db.Column(db.String, nullable=False)
    created_at = db.Column(db.DateTime, nullable=False, default=datetime.datetime.utcnow)


def init_db():
    # Cria as tabelas se ainda não existirem e garante admin padrão
    db.create_all()

    admin = User.query.filter_by(username="admin").first()
    if not admin:
        admin = User(
            username="admin",
            password="123",
            name="Administrador",
            email="admin@local",
            role="admin",
            created_at=datetime.datetime.utcnow(),
        )
        db.session.add(admin)
        db.session.commit()


def require_login(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if "username" not in session:
            return jsonify({"error": "Não autenticado"}), 401
        return fn(*args, **kwargs)
    return wrapper


def require_admin(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if "username" not in session:
            return jsonify({"error": "Não autenticado"}), 401
        user = get_current_user()
        if not user or user.get("role") != "admin":
            return jsonify({"error": "Acesso negado"}), 403
        return fn(*args, **kwargs)
    return wrapper


def parse_csv_text(text: str):
    # parse similar to frontend: delimitador ponto e vírgula
    linhas = text.splitlines()
    if not linhas:
        return []

    cabecalho = [c.strip() for c in linhas[0].split(";")]
    dados = []

    for linha in linhas[1:]:
        if not linha.strip():
            continue
        col = linha.split(";")
        if len(col) < len(cabecalho):
            continue
        item = {cabecalho[j]: col[j].strip() for j in range(len(cabecalho))}
        dados.append(item)

    return dados


@app.route("/api/load_csv", methods=["POST"])
@require_login
def api_load_csv():
    data = request.get_json() or {}
    path = (data.get("path") or "").strip()
    if not path:
        return jsonify({"error": "Caminho não informado"}), 400

    try:
        # Permitir paths UNC e caminhos locais de arquivos
        with open(path, "r", encoding="ISO-8859-1", errors="ignore") as f:
            text = f.read()

        dados = parse_csv_text(text)
        return jsonify(dados)
    except Exception as e:
        app.logger.warning("Erro ao ler arquivo CSV: %s", e)
        return jsonify({"error": "Falha ao ler arquivo CSV"}), 500


@app.route("/api/load_csv_url", methods=["POST"])
@require_login
def api_load_csv_url():
    data = request.get_json() or {}
    url = (data.get("url") or "").strip()
    if not url:
        return jsonify({"error": "URL não informada"}), 400

    try:
        import urllib.request

        # Alguns serviços exigem um User-Agent para retornar o conteúdo corretamente.
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            },
        )

        with urllib.request.urlopen(req, timeout=15) as resp:
            content = resp.read().decode("ISO-8859-1", errors="ignore")

        dados = parse_csv_text(content)
        return jsonify(dados)
    except Exception as e:
        app.logger.warning("Erro ao carregar CSV da URL: %s", e)
        return jsonify({"error": "Falha ao carregar CSV da URL"}), 500


# --- API de observações e anexos de pendente-autorizacao ---
@app.route("/api/pendente/<cod>/notes", methods=["GET"])
@require_login
def api_get_pendente_notes(cod):
    notes = PendenteNote.query.filter_by(cod_mdugo=cod).order_by(PendenteNote.created_at.desc()).all()
    return jsonify([
        {
            "id": n.id,
            "cod_mdugo": n.cod_mdugo,
            "note": n.note,
            "created_by": n.created_by,
            "created_at": n.created_at.isoformat(),
        }
        for n in notes
    ])


@app.route("/api/pendente/<cod>/notes", methods=["POST"])
@require_login
def api_post_pendente_note(cod):
    data = request.get_json() or {}
    note = (data.get("note") or "").strip()
    if not note:
        return jsonify({"error": "Observação vazia"}), 400

    user = get_current_user()
    if not user:
        return jsonify({"error": "Usuário não encontrado"}), 400

    pn = PendenteNote(
        cod_mdugo=cod,
        note=note,
        created_by=user.get("username") or user.get("name") or "",
        created_at=datetime.datetime.utcnow(),
    )
    db.session.add(pn)
    db.session.commit()
    return jsonify({"success": True})


@app.route("/api/pendente/<cod>/attachments", methods=["GET"])
@require_login
def api_get_pendente_attachments(cod):
    attachments = PendenteAttachment.query.filter_by(cod_mdugo=cod).order_by(PendenteAttachment.created_at.desc()).all()
    return jsonify([
        {
            "id": a.id,
            "cod_mdugo": a.cod_mdugo,
            "filename": a.filename,
            "content_type": a.content_type,
            "created_by": a.created_by,
            "created_at": a.created_at.isoformat(),
        }
        for a in attachments
    ])


@app.route("/api/pendente/<cod>/attachments/<int:att_id>", methods=["GET"])
@require_login
def api_download_pendente_attachment(cod, att_id):
    attachment = PendenteAttachment.query.filter_by(id=att_id, cod_mdugo=cod).first()
    if not attachment:
        return jsonify({"error": "Anexo não encontrado"}), 404

    return send_file(
        io.BytesIO(attachment.data),
        as_attachment=True,
        download_name=attachment.filename,
        mimetype=attachment.content_type or "application/octet-stream",
    )


@app.route("/api/pendente/<cod>/attachments", methods=["POST"])
@require_admin
def api_upload_pendente_attachment(cod):
    if "file" not in request.files:
        return jsonify({"error": "Nenhum arquivo enviado"}), 400

    file = request.files["file"]
    if not file or file.filename == "":
        return jsonify({"error": "Arquivo inválido"}), 400

    data = file.read()
    attachment = PendenteAttachment(
        cod_mdugo=cod,
        filename=secure_filename(file.filename),
        content_type=file.content_type,
        data=data,
        created_by=get_current_user().get("username") or "",
        created_at=datetime.datetime.utcnow(),
    )
    db.session.add(attachment)
    db.session.commit()
    return jsonify({"success": True})


def get_current_user():
    username = session.get("username")
    if not username:
        return None

    user = User.query.filter(db.func.lower(User.username) == username.lower()).first()
    return {
        "username": user.username,
        "name": user.name,
        "email": user.email,
        "role": user.role,
    } if user else None


@app.before_request
def enforce_login_for_pages():
    # Permite acesso livre a páginas de login/cadastro, arquivos estáticos e API.
    allowed = ["/login.html", "/register.html", "/", "/favicon.ico"]
    if request.path.startswith("/css") or request.path.startswith("/js") or request.path.startswith("/assets"):
        return
    if request.path.startswith("/api"):
        return
    if request.path in allowed:
        return

    # Se não estiver autenticado, redireciona para login
    if "username" not in session:
        return redirect("/login.html")


@app.route("/api/me", methods=["GET"])
def api_me():
    user = get_current_user()
    if not user:
        return jsonify({"authenticated": False}), 200
    return jsonify({"authenticated": True, "user": user})


@app.route("/api/login", methods=["POST"])
def api_login():
    data = request.get_json() or {}
    username = (data.get("username") or "").strip()
    password = (data.get("password") or "").strip()

    if not username or not password:
        return jsonify({"error": "Preencha usuário e senha"}), 400

    user = User.query.filter(db.func.lower(User.username) == username.lower()).first()
    if not user:
        return jsonify({"error": "Usuário não encontrado"}), 404

    if user.password != password:
        return jsonify({"error": "Senha incorreta"}), 401

    if user.role == "pending":
        return jsonify({"error": "Sua solicitação ainda está pendente"}), 403

    session["username"] = user.username
    return jsonify({"user": {"username": user.username, "name": user.name, "email": user.email, "role": user.role}})


@app.route("/api/logout", methods=["POST"])
@require_login
def api_logout():
    session.pop("username", None)
    return jsonify({"success": True})


@app.route("/api/register", methods=["POST"])
def api_register():
    data = request.get_json() or {}
    nome = (data.get("name") or "").strip()
    email = (data.get("email") or "").strip()
    username = (data.get("username") or "").strip()
    password = (data.get("password") or "").strip()

    if not nome or not email or not username or not password:
        return jsonify({"error": "Todos os campos são obrigatórios"}), 400

    existing = User.query.filter(db.func.lower(User.username) == username.lower()).first()
    if existing:
        return jsonify({"error": "Usuário já existe"}), 409

    now = datetime.datetime.utcnow()
    user = User(
        username=username,
        password=password,
        name=nome,
        email=email,
        role="pending",
        created_at=now,
    )
    db.session.add(user)
    db.session.commit()

    # Notificar administrador via email (se configurado)
    subject = f"Novo pedido de acesso: {username}"
    body = (
        f"Um novo usuário solicitou acesso ao portal.\n\n"
        f"Nome: {nome}\n"
        f"Email: {email}\n"
        f"Usuário: {username}\n"
        f"Data: {now.isoformat()}\n\n"
        "Acesse o portal e aprove ou rejeite a solicitação." 
    )
    send_admin_email(subject, body)

    # A solicitação fica registrada no portal (lista de pendentes) para que o administrador aprove/negue.
    return jsonify({"message": "Solicitação enviada"})


@app.route("/api/pending", methods=["GET"])
@require_admin
def api_pending():
    rows = User.query.filter_by(role="pending").order_by(User.created_at.desc()).all()
    return jsonify([
        {
            "username": u.username,
            "name": u.name,
            "email": u.email,
            "created_at": u.created_at.isoformat(),
        }
        for u in rows
    ])


@app.route("/api/history", methods=["GET"])
@require_admin
def api_history():
    # Retorna histórico de solicitações aprovadas ou rejeitadas
    rows = User.query.filter(User.role.in_(["pending", "admin", "viewer", "rejected"]))
    rows = rows.order_by(User.created_at.desc()).all()

    return jsonify([
        {
            "username": u.username,
            "name": u.name,
            "email": u.email,
            "role": u.role,
            "created_at": u.created_at.isoformat(),
            "decision_at": u.approved_at.isoformat() if u.approved_at else None,
        }
        for u in rows
    ])


@app.route("/api/approve", methods=["POST"])
@require_admin
def api_approve():
    data = request.get_json() or {}
    username = (data.get("username") or "").strip()
    role = (data.get("role") or "").strip() or "viewer"

    if not username:
        return jsonify({"error": "Usuário obrigatório"}), 400

    user = User.query.filter(db.func.lower(User.username) == username.lower()).first()
    if not user:
        return jsonify({"error": "Usuário não encontrado"}), 404

    user.role = role
    user.approved_at = datetime.datetime.utcnow()
    db.session.commit()
    return jsonify({"success": True})


@app.route("/api/deny", methods=["POST"])
@require_admin
def api_deny():
    data = request.get_json() or {}
    username = (data.get("username") or "").strip()

    if not username:
        return jsonify({"error": "Usuário obrigatório"}), 400

    user = User.query.filter(db.func.lower(User.username) == username.lower()).first()
    if not user:
        return jsonify({"error": "Usuário não encontrado"}), 404

    # Não removemos da base para manter histórico; apenas marcamos como rejeitado.
    user.role = "rejected"
    user.approved_at = datetime.datetime.utcnow()
    db.session.commit()
    return jsonify({"success": True})


@app.route("/", defaults={"path": "login.html"})
@app.route("/<path:path>")
def serve_static(path):
    # Serve arquivos estáticos (HTML/CSS/JS) diretamente
    if os.path.exists(os.path.join(BASE_DIR, path)):
        return send_from_directory(BASE_DIR, path)
    return send_from_directory(BASE_DIR, "login.html")


if __name__ == "__main__":
    init_db()
    app.run(host="0.0.0.0", port=5000, debug=True)
