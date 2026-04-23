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
import json
import datetime
import smtplib
import ssl
from email.message import EmailMessage
from functools import wraps

from flask import Flask, request, jsonify, session, redirect, send_from_directory, send_file, render_template
from flask_cors import CORS
from flask_sqlalchemy import SQLAlchemy
from dotenv import load_dotenv
from werkzeug.utils import secure_filename

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(BASE_DIR, ".env"))

DEFAULT_ALLOWED_ORIGINS = [
    "http://localhost:5000",
    "http://127.0.0.1:5000",
    "https://f3lip31993.github.io",
]
CORS_ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.environ.get("CORS_ALLOWED_ORIGINS", ",".join(DEFAULT_ALLOWED_ORIGINS)).split(",")
    if origin.strip()
]

app = Flask(__name__, static_folder=BASE_DIR, static_url_path="")
app.secret_key = os.environ.get("PORTAL_SECRET_KEY", "troque-essa-chave")
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = os.environ.get("SESSION_COOKIE_SAMESITE", "Lax")
app.config["SESSION_COOKIE_SECURE"] = os.environ.get("SESSION_COOKIE_SECURE", "false").lower() == "true"
CORS(app, supports_credentials=True, origins=CORS_ALLOWED_ORIGINS)

# Use DATABASE_URL para PostgreSQL (ou outro DB compatível com SQLAlchemy).
# Exemplo: postgresql://user:pass@localhost:5432/portal
DATABASE_URL = os.environ.get("DATABASE_URL")
if DATABASE_URL and DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)
if not DATABASE_URL:
    DATABASE_URL = f"sqlite:///{os.path.join(BASE_DIR, 'portal.db')}"

app.config["SQLALCHEMY_DATABASE_URI"] = DATABASE_URL
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
app.config["SQLALCHEMY_ENGINE_OPTIONS"] = {"pool_pre_ping": True}

# Modo read-only (apenas visualização, sem edições)
READ_ONLY_MODE = os.environ.get("READ_ONLY_MODE", "false").lower() == "true"
READ_ONLY_SHARED_TOKEN = os.environ.get("READ_ONLY_SHARED_TOKEN", None)

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
    registration_obs = db.Column(db.Text, nullable=True)
    epo_access = db.Column(db.Text, nullable=True)  # JSON list de EPOs permitidas, None = todas
    must_change_password = db.Column(db.Boolean, nullable=False, default=False)


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


class ProjetoFNote(db.Model):
    __tablename__ = "projeto_f_notes"

    id = db.Column(db.Integer, primary_key=True)
    codged = db.Column(db.String, nullable=False, index=True)
    note = db.Column(db.Text, nullable=False)
    created_by = db.Column(db.String, nullable=False)
    created_at = db.Column(db.DateTime, nullable=False, default=datetime.datetime.utcnow)


class ProjetoFAttachment(db.Model):
    __tablename__ = "projeto_f_attachments"

    id = db.Column(db.Integer, primary_key=True)
    codged = db.Column(db.String, nullable=False, index=True)
    filename = db.Column(db.String, nullable=False)
    content_type = db.Column(db.String, nullable=True)
    data = db.Column(db.LargeBinary, nullable=False)
    created_by = db.Column(db.String, nullable=False)
    created_at = db.Column(db.DateTime, nullable=False, default=datetime.datetime.utcnow)


class SharedDataset(db.Model):
    __tablename__ = "shared_datasets"

    id = db.Column(db.Integer, primary_key=True)
    category = db.Column(db.String, unique=True, nullable=False, index=True)
    data_json = db.Column(db.Text, nullable=False, default="[]")
    updated_by = db.Column(db.String, nullable=True)
    updated_at = db.Column(db.DateTime, nullable=False, default=datetime.datetime.utcnow)


def init_db():
    from sqlalchemy import text, inspect as sqla_inspect
    # Cria as tabelas se ainda não existirem e garante admin padrão
    db.create_all()

    # Migração: adiciona coluna registration_obs se ainda não existir
    try:
        insp = sqla_inspect(db.engine)
        cols = [c["name"] for c in insp.get_columns("users")]
        if "registration_obs" not in cols:
            with db.engine.connect() as conn:
                conn.execute(text("ALTER TABLE users ADD COLUMN registration_obs TEXT"))
                conn.commit()
        if "epo_access" not in cols:
            with db.engine.connect() as conn:
                conn.execute(text("ALTER TABLE users ADD COLUMN epo_access TEXT"))
                conn.commit()
        if "must_change_password" not in cols:
            with db.engine.connect() as conn:
                conn.execute(text("ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0"))
                conn.commit()
    except Exception as e:
        app.logger.warning("Migração registration_obs ignorada: %s", e)

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
@require_admin
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
@require_admin
def api_load_csv_url():
    data = request.get_json() or {}
    url = (data.get("url") or "").strip()
    if not url:
        return jsonify({"error": "URL não informada"}), 400

    try:
        import urllib.request
        import ssl

        # Alguns serviços exigem um User-Agent para retornar o conteúdo corretamente.
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            },
        )

        ssl_context = ssl._create_unverified_context()
        with urllib.request.urlopen(req, timeout=15, context=ssl_context) as resp:
            content = resp.read().decode("ISO-8859-1", errors="ignore")

        dados = parse_csv_text(content)
        return jsonify(dados)
    except Exception as e:
        app.logger.warning("Erro ao carregar CSV da URL: %s", e)
        return jsonify({"error": "Falha ao carregar CSV da URL"}), 500


@app.route("/api/backlog/<categoria>", methods=["GET"])
def api_backlog_categoria(categoria):
    backlog_path = os.path.join(BASE_DIR, "BACKLOG_MDU_SPINTERIOR.csv")
    if not os.path.exists(backlog_path):
        return jsonify({"error": "Arquivo BACKLOG não encontrado"}), 404

    try:
        with open(backlog_path, "r", encoding="ISO-8859-1", errors="ignore") as f:
            text = f.read()

        dados = parse_csv_text(text)

        if categoria == "empresarial":
            filtrados = [item for item in dados if item.get("SOLICITANTE", "").strip().upper() == "EMPRESARIAL" and 
                        item.get("STATUS_GERAL", "").strip() in ["1.VISTORIA", "2.PROJETO_INTERNO", "3.PROJETO_REDE", "4.CONSTRUCAO_REDE", "5.CONSTRUCAO", "7.LIBERACAO"]]
        elif categoria == "mdu-ongoing":
            status_validos = ["1.VISTORIA", "2.PROJETO_INTERNO", "5.CONSTRUCAO", "7.EM_LIBERACAO", "EXPANSÃO_MDU", "4.CONSTRUCAO_REDE", "3.PROJETO_REDE"]
            motivos_validos = [
                "5.CONSTRUCAO_INTERNA", "7.EM_LIBERACAO", "4.PEND_EXECUTAR_SAR", "2.PROJETO_INTERNO_BACKBONE", "3.PROJETO_SAR", "1.VISTORIA", 
                "4.FIBRA_SEM_SINAL", "6.AGUARDANDO_ASBUILT", "8.VALIDAÇÃO_VISTORIA_SIMPLIFICADA", "4.REPROJETO_SAR", "5.CONSTRUCAO_INTERNA_AGENDADA", 
                "1.VISTORIA_AGENDADA", "AGUARDANDO_AGEND_COMERCIAL", "AGUARDANDO_AGEND_CLIENTE_SGD", "AGUARDANDO_CRIAÇAO_END_GED", 
                "AGUARDANDO_AGEND_TECNICA", "6.ATIVAÇÃO_MDU_CONSTRUIDO", "AGUARDANDO_DE_ACORDO_DIRETOR", "AGUARDANDO_CRIAÇAO_END_GED", 
                "AGUARDANDO_ESTUDO_SAR", "AGUARDANDO_APRO_COMERCIAL", "1.PENDENTE_RETORNO_VISTORIA_EPO", "2.VALIDAÇÃO_VISTORIA", 
                "4.REDE_GPON_ESTRUTURADO", "1.MEDIÇÃO_PENDENTE_ENVIO_PLANILHA_EPO"
            ]
            filtrados = [item for item in dados if item.get("STATUS_GERAL", "").strip() in status_validos and 
                        item.get("MOTIVO_GERAL", "").strip() in motivos_validos]
        elif categoria == "pendente-autorizacao":
            status_validos = ["1.FILA_PENDENTE_AUTORIZAÇÃO_VISTORIA", "4.FILA_PENDENTE_AUTORIZAÇÃO_BACKBONE"]
            filtrados = [item for item in dados if item.get("STATUS_GERAL", "").strip().upper() in status_validos]
            for item in filtrados:
                if "VISTORIA" in item.get("STATUS_GERAL", "").upper():
                    item["__pendenteTipo"] = "vistoria"
                elif "BACKBONE" in item.get("STATUS_GERAL", "").upper():
                    item["__pendenteTipo"] = "backbone"
        elif categoria == "sar-rede":
            filtrados = [
                item for item in dados
                if "SAR" in item.get("SOLICITANTE", "").upper()
                or "SAR" in item.get("STATUS_GERAL", "").upper()
                or "SAR" in item.get("MOTIVO_GERAL", "").upper()
            ]
        else:
            return jsonify({"error": "Categoria não suportada"}), 400

        return jsonify(filtrados)
    except Exception as e:
        app.logger.warning("Erro ao carregar BACKLOG para categoria %s: %s", categoria, e)
        return jsonify({"error": "Falha ao carregar dados"}), 500


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

    send_admin_email(
        subject=f"Nova observação no portal: {cod}",
        body=(
            f"Uma nova observação foi registrada no portal.\n\n"
            f"Código/Endereço: {cod}\n"
            f"Autor: {user.get('name') or user.get('username') or '-'}\n"
            f"Usuário: {user.get('username') or '-'}\n"
            f"OBS: {note}\n"
        ),
    )

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


# --- API de observações e anexos de projeto_f ---
@app.route("/api/projeto_f/<codged>/notes", methods=["GET"])
@require_login
def api_get_projeto_f_notes(codged):
    notes = ProjetoFNote.query.filter_by(codged=codged).order_by(ProjetoFNote.created_at.desc()).all()
    return jsonify([
        {
            "id": n.id,
            "codged": n.codged,
            "note": n.note,
            "created_by": n.created_by,
            "created_at": n.created_at.isoformat(),
        }
        for n in notes
    ])


@app.route("/api/projeto_f/<codged>/notes", methods=["POST"])
@require_login
def api_post_projeto_f_note(codged):
    data = request.get_json() or {}
    note = (data.get("note") or "").strip()
    if not note:
        return jsonify({"error": "Observação vazia"}), 400

    user = get_current_user()
    if not user:
        return jsonify({"error": "Usuário não encontrado"}), 400

    pn = ProjetoFNote(
        codged=codged,
        note=note,
        created_by=user.get("username") or user.get("name") or "",
        created_at=datetime.datetime.utcnow(),
    )
    db.session.add(pn)
    db.session.commit()

    send_admin_email(
        subject=f"Nova observação no Projeto F: {codged}",
        body=(
            f"Uma nova observação foi registrada no Projeto F.\n\n"
            f"Código: {codged}\n"
            f"Autor: {user.get('name') or user.get('username') or '-'}\n"
            f"Usuário: {user.get('username') or '-'}\n"
            f"OBS: {note}\n"
        ),
    )

    return jsonify({"success": True})


@app.route("/api/projeto_f/<codged>/attachments", methods=["GET"])
@require_login
def api_get_projeto_f_attachments(codged):
    attachments = ProjetoFAttachment.query.filter_by(codged=codged).order_by(ProjetoFAttachment.created_at.desc()).all()
    return jsonify([
        {
            "id": a.id,
            "codged": a.codged,
            "filename": a.filename,
            "content_type": a.content_type,
            "created_by": a.created_by,
            "created_at": a.created_at.isoformat(),
        }
        for a in attachments
    ])


@app.route("/api/projeto_f/<codged>/attachments/<int:att_id>", methods=["GET"])
@require_login
def api_download_projeto_f_attachment(codged, att_id):
    attachment = ProjetoFAttachment.query.filter_by(id=att_id, codged=codged).first()
    if not attachment:
        return jsonify({"error": "Anexo não encontrado"}), 404

    return send_file(
        io.BytesIO(attachment.data),
        as_attachment=True,
        download_name=attachment.filename,
        mimetype=attachment.content_type or "application/octet-stream",
    )


@app.route("/api/projeto_f/<codged>/attachments", methods=["POST"])
@require_login
def api_upload_projeto_f_attachment(codged):
    user = get_current_user() or {}
    if user.get("role") != "admin":
        return jsonify({"error": "Apenas administrador pode anexar arquivos"}), 403

    if "file" not in request.files:
        return jsonify({"error": "Nenhum arquivo enviado"}), 400

    file = request.files["file"]
    if not file or file.filename == "":
        return jsonify({"error": "Arquivo inválido"}), 400

    data = file.read()
    attachment = ProjetoFAttachment(
        codged=codged,
        filename=secure_filename(file.filename),
        content_type=file.content_type,
        data=data,
        created_by=user.get("username") or "",
        created_at=datetime.datetime.utcnow(),
    )
    db.session.add(attachment)
    db.session.commit()
    return jsonify({"success": True})


@app.route("/api/pendente/<cod>/attachments", methods=["POST"])
@require_login
def api_upload_pendente_attachment(cod):
    user = get_current_user() or {}
    if user.get("role") != "admin":
        return jsonify({"error": "Apenas administrador pode anexar arquivos"}), 403

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
        created_by=user.get("username") or "",
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
    if not user:
        return None
    try:
        epo_list = json.loads(user.epo_access or "null")
    except Exception:
        epo_list = None
    return {
        "username": user.username,
        "name": user.name,
        "email": user.email,
        "role": user.role,
        "epo_access": epo_list,
        "must_change_password": bool(getattr(user, 'must_change_password', False)),
    }


def build_notifications_feed(limit: int = 30):
    events = []

    recent_users = (
        User.query
        .filter(db.func.lower(User.username) != "admin")
        .order_by(User.created_at.desc())
        .limit(limit)
        .all()
    )

    for u in recent_users:
        role_label = {
            "viewer": "Acompanhamento",
            "admin": "Administrador",
            "pending": "Pendente",
            "rejected": "Rejeitado",
        }.get((u.role or "").lower(), u.role or "Usuário")

        events.append({
            "type": "cadastro",
            "entity": "cadastro",
            "source": "Cadastro",
            "title": f"{u.name or u.username} fez o cadastro. O que será permitido?",
            "subtitle": f"Usuário: {u.username}",
            "message": f"E-mail: {u.email or 'sem e-mail'} • Status: {role_label}",
            "obs": u.registration_obs or "",
            "created_by": u.username,
            "created_at": u.created_at.isoformat() if u.created_at else None,
            "reference": u.username,
        })

    recent_pendente_notes = (
        PendenteNote.query
        .order_by(PendenteNote.created_at.desc())
        .limit(limit)
        .all()
    )
    recent_projeto_f_notes = (
        ProjetoFNote.query
        .order_by(ProjetoFNote.created_at.desc())
        .limit(limit)
        .all()
    )

    for n in recent_pendente_notes:
        preview = (n.note or "").strip().replace("\n", " ")
        if len(preview) > 140:
            preview = preview[:137] + "..."

        events.append({
            "type": "observacao",
            "entity": "pendente",
            "source": "Endereço / acompanhamento",
            "title": f"Nova OBS no endereço {n.cod_mdugo}",
            "subtitle": f"Código: {n.cod_mdugo}",
            "message": preview or "Observação adicionada no portal.",
            "created_by": n.created_by,
            "created_at": n.created_at.isoformat() if n.created_at else None,
            "reference": n.cod_mdugo,
        })

    for n in recent_projeto_f_notes:
        preview = (n.note or "").strip().replace("\n", " ")
        if len(preview) > 140:
            preview = preview[:137] + "..."

        events.append({
            "type": "observacao",
            "entity": "projeto_f",
            "source": "Projeto F",
            "title": f"Nova OBS no Projeto F {n.codged}",
            "subtitle": f"Código: {n.codged}",
            "message": preview or "Observação adicionada no portal.",
            "created_by": n.created_by,
            "created_at": n.created_at.isoformat() if n.created_at else None,
            "reference": n.codged,
        })

    events.sort(key=lambda item: item.get("created_at") or "", reverse=True)
    return events[:limit]


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
        return jsonify({"error": "Sua solicitação está aguardando aprovação do administrador"}), 403

    if user.role == "rejected":
        return jsonify({"error": "Seu acesso foi recusado. Fale com o administrador do portal"}), 403

    session["username"] = user.username
    try:
        epo_list = json.loads(user.epo_access or "null")
    except Exception:
        epo_list = None
    return jsonify({"user": {
        "username": user.username,
        "name": user.name,
        "email": user.email,
        "role": user.role,
        "epo_access": epo_list,
        "must_change_password": bool(getattr(user, 'must_change_password', False)),
    }})


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
    obs = (data.get("obs") or "").strip()[:500]

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
        approved_at=None,
        registration_obs=obs or None,
    )
    db.session.add(user)
    db.session.commit()

    # Notificar administrador via email (se configurado)
    subject = f"Nova solicitação de acesso: {username}"
    body = (
        f"Uma nova solicitação de acesso foi registrada no portal.\n\n"
        f"Nome: {nome}\n"
        f"Email: {email}\n"
        f"Usuário: {username}\n"
        f"Status inicial: pending\n"
        f"Data: {now.isoformat()}\n"
        + (f"OBS: {obs}\n" if obs else "")
        + f"\nA decisão deve ser feita pelo administrador do portal."
    )
    send_admin_email(subject, body)

    return jsonify({
        "message": "Solicitação enviada com sucesso. Aguarde a aprovação do administrador.",
        "user": {
            "username": user.username,
            "name": user.name,
            "email": user.email,
            "role": user.role,
        }
    })


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


@app.route("/api/user_profile", methods=["GET"])
@require_login
def api_user_profile():
    """Retorna informações do usuário logado, incluindo dados de cadastro."""
    user = get_current_user()
    if not user:
        return jsonify({"error": "Não autenticado"}), 401

    return jsonify({
        "username": user.get("username"),
        "name": user.get("name"),
        "email": user.get("email"),
        "role": user.get("role"),
        "registration_obs": user.get("registration_obs"),
        "created_at": user.get("created_at"),
        "approved_at": user.get("approved_at"),
    })


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


@app.route("/api/notifications_feed", methods=["GET"])
@require_admin
def api_notifications_feed():
    try:
        limit = int(request.args.get("limit", 30))
    except (TypeError, ValueError):
        limit = 30

    limit = max(1, min(limit, 100))
    return jsonify(build_notifications_feed(limit))


@app.route("/api/admin/create_epo_user", methods=["POST"])
@require_admin
def api_create_epo_user():
    """Admin cria usuário com acesso restrito a EPOs específicas."""
    data = request.get_json() or {}
    nome = (data.get("name") or "").strip()
    username = (data.get("username") or "").strip()
    epos = data.get("epo_access")  # lista de strings ou None
    senha_padrao = (data.get("password") or "MDU@2026").strip()

    if not nome or not username:
        return jsonify({"error": "Nome e usuário são obrigatórios"}), 400

    existing = User.query.filter(db.func.lower(User.username) == username.lower()).first()
    if existing:
        return jsonify({"error": "Usuário já existe"}), 409

    epo_json = json.dumps(epos, ensure_ascii=False) if isinstance(epos, list) and epos else None

    user = User(
        username=username,
        password=senha_padrao,
        name=nome,
        email=f"{username}@epo.local",
        role="viewer",
        created_at=datetime.datetime.utcnow(),
        approved_at=datetime.datetime.utcnow(),
        epo_access=epo_json,
        must_change_password=True,
    )
    db.session.add(user)
    db.session.commit()

    return jsonify({"success": True, "username": username, "password": senha_padrao, "epo_access": epos})


@app.route("/api/change_password", methods=["POST"])
@require_login
def api_change_password():
    """Usuário logado troca a própria senha."""
    data = request.get_json() or {}
    new_password = (data.get("new_password") or "").strip()

    if len(new_password) < 4:
        return jsonify({"error": "A nova senha deve ter ao menos 4 caracteres"}), 400

    user = User.query.filter(db.func.lower(User.username) == session["username"].lower()).first()
    if not user:
        return jsonify({"error": "Usuário não encontrado"}), 404

    user.password = new_password
    user.must_change_password = False
    db.session.commit()
    return jsonify({"success": True})


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


@app.route("/api/config", methods=["GET"])
def api_config():
    """Retorna informações de configuração do portal, incluindo modo read-only"""
    return jsonify({
        "readOnly": READ_ONLY_MODE,
        "version": "1.0",
        "portalName": "Portal de Endereços",
        "apiBaseUrl": request.host_url.rstrip("/"),
        "allowedOrigins": CORS_ALLOWED_ORIGINS,
    })


@app.route("/api/shared_datasets", methods=["GET"])
def api_get_shared_datasets():
    rows = SharedDataset.query.order_by(SharedDataset.category.asc()).all()
    datasets = {}

    for row in rows:
        try:
            parsed = json.loads(row.data_json or "[]")
        except Exception:
            parsed = []

        datasets[row.category] = {
            "items": parsed if isinstance(parsed, list) else [],
            "updated_by": row.updated_by or "",
            "updated_at": row.updated_at.isoformat() if row.updated_at else None,
        }

    return jsonify({"datasets": datasets})


@app.route("/api/shared_datasets/<categoria>", methods=["POST"])
@require_admin
def api_save_shared_dataset(categoria):
    data = request.get_json() or {}
    items = data.get("items")

    if not isinstance(items, list):
        return jsonify({"error": "Os dados devem ser enviados em formato de lista"}), 400

    row = SharedDataset.query.filter_by(category=categoria).first()
    if not row:
        row = SharedDataset(category=categoria)

    row.data_json = json.dumps(items, ensure_ascii=False)
    row.updated_by = (get_current_user() or {}).get("username", "")
    row.updated_at = datetime.datetime.utcnow()
    db.session.add(row)
    db.session.commit()

    return jsonify({"success": True, "category": categoria, "count": len(items)})


@app.route("/api/projeto_f_dataset", methods=["GET"])
def api_projeto_f_dataset():
    """Retorna dados do Projeto F para qualquer usuario autenticado."""
    try:
        df = carregar_projeto_f()
        if df is None or df.empty:
            return jsonify({"items": []})

        rows = df.to_dict(orient="records")
        return jsonify({"items": rows})
    except Exception as e:
        app.logger.warning("Erro ao carregar dataset Projeto F: %s", e)
        return jsonify({"items": [], "error": "Falha ao carregar Projeto F"}), 500


@app.route("/", defaults={"path": "login.html"})
@app.route("/<path:path>")
def serve_static(path):
    # Serve arquivos estáticos (HTML/CSS/JS) diretamente
    if os.path.exists(os.path.join(BASE_DIR, path)):
        return send_from_directory(BASE_DIR, path)
    return send_from_directory(BASE_DIR, "login.html")

# ------------------------------------------
# ✅ FUNÇÃO PARA CARREGAR PROJETO F
# ------------------------------------------
# URL para download direto do SharePoint (deve ser um link de download real)
URL_PROJETO_F = "https://corpclarobr-my.sharepoint.com/:x:/g/personal/wellington_rodriguessouza_claro_com_br/IQA0snk4XoFPSIEw93s_oIKFATs7SE92lNmIXHW5_cGwJhU?email=Mauro.Faria%40claro.com.br&e=B9IfAE"

# Arquivo local como backup (se preferir)
LOCAL_PROJETO_F = os.path.join(BASE_DIR, "CONSTRU%C3%87%C3%83O%20MDU%20PROJETO_F.xlsx")

def carregar_projeto_f():
    try:
        import pandas as pd
        import requests
        from io import BytesIO

        try:
            requests.packages.urllib3.disable_warnings()
        except Exception:
            pass
        
        # Tentar baixar do OneDrive/SharePoint primeiro
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
        
        # Para downloads do SharePoint, usar o parâmetro download
        url_download = URL_PROJETO_F.split('?')[0] + '?download=1'
        
        try:
            response = requests.get(url_download, headers=headers, timeout=10, verify=False)
            response.raise_for_status()
            df = pd.read_excel(BytesIO(response.content), sheet_name="BOM_PROJETO_F", engine="openpyxl")
            app.logger.info("Projeto F carregado do OneDrive/SharePoint com sucesso")
            return df
        except:
            # Se falhar, tentar sem modificação de URL
            response = requests.get(URL_PROJETO_F, headers=headers, timeout=10, verify=False)
            response.raise_for_status()
            df = pd.read_excel(BytesIO(response.content), sheet_name="BOM_PROJETO_F", engine="openpyxl")
            app.logger.info("Projeto F carregado do OneDrive/SharePoint (tentativa 2)")
            return df
            
    except Exception as e:
        app.logger.warning(f"Erro ao carregar de OneDrive/SharePoint ({e}), tentando arquivo local...")
        
        # Fallback: tentar carregara arquivo local se existir
        try:
            import pandas as pd
            # Procurar por qualquer arquivo .xlsx no diretório
            import glob
            xlsx_files = glob.glob(os.path.join(BASE_DIR, "*.xlsx"))
            if xlsx_files:
                df = pd.read_excel(xlsx_files[0], sheet_name="BOM_PROJETO_F", engine="openpyxl")
                app.logger.info(f"Projeto F carregado do arquivo local: {xlsx_files[0]}")
                return df
        except Exception as e2:
            app.logger.error(f"Erro ao tentar arquivo local: {e2}")
        
        # Retornar DataFrame vazio com estrutura padrão
        app.logger.error(f"Falha ao carregar Projeto F: {e}")
        import pandas as pd
        return pd.DataFrame(columns=["CIDADE", "CODGED", "ENDEREÇO", "STATUS MDU", "LIBERAÇÃO CONCLUIDA?", "PARCEIRA", "DT_CONSTRUÇÃO", "OBS", "DDD"])

# ------------------------------------------
# ✅ ROTA: LISTAGEM DO PROJETO F
# ------------------------------------------
@app.route("/projeto_f")
def projeto_f():
    try:
        df = carregar_projeto_f()
        
        if df.empty:
            return """
            <div style="padding: 20px; background: #fff3cd; border: 1px solid #ffc107; border-radius: 5px; margin: 20px;">
                <h3>⚠️ Aviso</h3>
                <p>Não foi possível carregar o arquivo Projeto F.</p>
                <p><strong>Solução:</strong></p>
                <ol>
                    <li>Faça download do arquivo <a href="https://corpclarobr-my.sharepoint.com/:x:/r/personal/wellington_rodriguessouza_claro_com_br/Documents/POWER%20BI%20-%20CONSTRU%C3%87%C3%83O%20MDU%20RSI/CONSTRU%C3%87%C3%83O%20MDU%20PROJETO_F.xlsx?d=w3879b234815e484f8130f77b3fa08285&csf=1&web=1&e=9jpNtA" target="_blank">aqui</a></li>
                    <li>Coloque o arquivo .xlsx na pasta do portal</li>
                    <li>Recarregue a página</li>
                </ol>
                <a href="/projeto_f" style="padding: 10px 20px; background: #0056b3; color: white; text-decoration: none; border-radius: 4px;">↻ Tentar novamente</a>
            </div>
            """

        colunas = [
            "CIDADE",
            "CODGED",
            "ENDEREÇO",
            "STATUS MDU",
            "LIBERAÇÃO CONCLUIDA?",
            "PARCEIRA"
        ]

        dados = df[colunas].to_dict(orient="records")
        return render_template("projeto_f.html", dados=dados)
    except Exception as e:
        app.logger.error(f"Erro na rota projeto_f: {e}")
        return f"""
        <div style="padding: 20px; background: #f8d7da; border: 1px solid #f5c6cb; border-radius: 5px; margin: 20px;">
            <h3>❌ Erro ao carregar Projeto F</h3>
            <p>Detalhes: {str(e)}</p>
            <a href="/projeto_f" style="padding: 10px 20px; background: #dc3545; color: white; text-decoration: none; border-radius: 4px;">↻ Tentar novamente</a>
        </div>
        """, 500

# ------------------------------------------
# ✅ ROTA: DETALHES DO PROJETO F
# ------------------------------------------
@app.route("/projeto_f/<string:codged>")
def projeto_f_detalhes(codged):
    try:
        df = carregar_projeto_f()
        linha = df[df["CODGED"].astype(str) == str(codged)]

        if linha.empty:
            return """
            <div style="padding: 20px; background: #f8d7da; border: 1px solid #f5c6cb; border-radius: 5px; margin: 20px;">
                <h3>❌ Projeto não encontrado</h3>
                <p>Código CODGED: """ + codged + """</p>
                <a href="/projeto_f" style="padding: 10px 20px; background: #0056b3; color: white; text-decoration: none; border-radius: 4px;">⬅ Voltar</a>
            </div>
            """, 404

        dados = linha.iloc[0].to_dict()
        
        # Buscar observações e anexos
        notes = ProjetoFNote.query.filter_by(codged=codged).order_by(ProjetoFNote.created_at.desc()).all()
        attachments = ProjetoFAttachment.query.filter_by(codged=codged).order_by(ProjetoFAttachment.created_at.desc()).all()
        
        return render_template("projeto_f_detalhes.html", 
                             dados=dados, 
                             notes=notes, 
                             attachments=attachments)
    except Exception as e:
        app.logger.error(f"Erro na rota projeto_f_detalhes: {e}")
        return f"""
        <div style="padding: 20px; background: #f8d7da; border: 1px solid #f5c6cb; border-radius: 5px; margin: 20px;">
            <h3>❌ Erro ao carregar detalhes</h3>
            <p>Detalhes: {str(e)}</p>
            <a href="/projeto_f" style="padding: 10px 20px; background: #0056b3; color: white; text-decoration: none; border-radius: 4px;">⬅ Voltar</a>
        </div>
        """, 500

with app.app_context():
    init_db()

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    debug_mode = os.environ.get("FLASK_DEBUG", "true").lower() == "true"
    app.run(host="0.0.0.0", port=port, debug=debug_mode)
