#!/usr/bin/env python3
"""
Ferramenta de publicação para Portal de Endereços.

Permite publicar o portal em modo read-only com um link compartilhável.
O modo read-only desabilita todas as operações de escrita (importar, editar, excluir).

Uso:
    python publish.py --mode readonly --port 5000
    python publish.py --mode server  # Modo normal com autenticação
    python publish.py --generate-token  # Gera um token único para compartilhamento
"""

import os
import sys
import argparse
import uuid
import json
from pathlib import Path
from datetime import datetime, timedelta

def get_workspace_root():
    """Retorna a raiz do workspace (diretório atual é o padrão)"""
    return os.path.dirname(os.path.abspath(__file__))

def create_env_file(workspace_root, mode="server", port=5000, token=None):
    """Cria ou atualiza o arquivo .env com as configurações de publicação"""
    env_file = os.path.join(workspace_root, ".env")
    
    env_content = f"""# Portal de Endereços - Configurações
# Gerado em: {datetime.now().isoformat()}

# Modo de execução: 'server' (normal) ou 'readonly' (apenas visualização)
READ_ONLY_MODE={'true' if mode == 'readonly' else 'false'}

# Token para compartilhamento em modo read-only (opcional)
READ_ONLY_SHARED_TOKEN={token or ''}

# Configurações Flask
FLASK_ENV=production
FLASK_DEBUG=false
PORT={port}
PORTAL_SECRET_KEY={os.environ.get('PORTAL_SECRET_KEY', 'change-me-in-production')}
SESSION_COOKIE_SECURE={'true' if mode != 'server' else 'false'}
SESSION_COOKIE_SAMESITE={'None' if mode != 'server' else 'Lax'}
CORS_ALLOWED_ORIGINS=https://f3lip31993.github.io,http://localhost:{port}

# Banco de dados (SQLite por padrão)
DATABASE_URL=sqlite:///portal.db

# Configurações SMTP (opcional)
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_FROM=no-reply@portal.local
ADMIN_EMAIL=
"""
    
    with open(env_file, "w") as f:
        f.write(env_content)
    
    print(f"✓ Arquivo .env criado/atualizado: {env_file}")

def create_publish_config(workspace_root, mode, port, token):
    """Cria um arquivo de configuração de publicação"""
    config_file = os.path.join(workspace_root, "publish_config.json")
    
    config = {
        "timestamp": datetime.now().isoformat(),
        "mode": mode,
        "port": port,
        "token": token,
        "readonly_enabled": mode == "readonly",
        "instructions": {
            "readonly": "✓ Portal em modo READ-ONLY. Usuários podem visualizar mas não editar.",
            "server": "✓ Portal em modo normal com autenticação."
        }
    }
    
    with open(config_file, "w") as f:
        json.dump(config, f, indent=2)
    
    print(f"✓ Configuração de publicação salva: {config_file}")
    return config

def generate_token():
    """Gera um token único para compartilhamento"""
    return str(uuid.uuid4())[:12]

def print_connection_info(port, mode, token=None, hostname="localhost"):
    """Exibe informações de conexão"""
    print("\n" + "=" * 70)
    print(f"Portal de Endereços - {mode.upper()}")
    print("=" * 70)
    
    if mode == "readonly":
        share_url = f"http://{hostname}:{port}?token={token}" if token else f"http://{hostname}:{port}"
        print(f"\n📋 URL de acesso (READ-ONLY):")
        print(f"   {share_url}")
        print(f"\n🔐 Token de compartilhamento: {token}")
        print(f"\n📌 Características em modo READ-ONLY:")
        print(f"   • Visualização de dados completa")
        print(f"   • Sem permissão para editar")
        print(f"   • Sem permissão para importar CSVs")
        print(f"   • Sem permissão para excluir registros")
    else:
        print(f"\n🔗 URL de acesso:")
        print(f"   http://{hostname}:{port}/login.html")
        print(f"\n👤 Usuário padrão: admin")
        print(f"📌 Este é um ambiente normal com autenticação ativa")
    
    print("\n" + "=" * 70)
    print("\n💡 Para acessar em outro computador, substitua 'localhost' pelo IP ou domínio")
    print(f"   Ex: http://<seu-ip>:{port}")
    print("\n")

def main():
    parser = argparse.ArgumentParser(
        description="Ferramenta de publicação - Portal de Endereços",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Exemplos:
  python publish.py --mode readonly          # Modo read-only com token aleatório
  python publish.py --mode readonly --token abc123  # Com token específico
  python publish.py --mode server --port 5001      # Modo normal em porta específica
  python publish.py --generate-token         # Apenas gera um novo token
        """
    )
    
    parser.add_argument("--mode", 
                       choices=["server", "readonly"],
                       default="server",
                       help="Modo de publicação (padrão: server)")
    
    parser.add_argument("--port",
                       type=int,
                       default=5000,
                       help="Porta para o servidor (padrão: 5000)")
    
    parser.add_argument("--token",
                       help="Token para modo read-only (aleatório se não especificado)")
    
    parser.add_argument("--generate-token",
                       action="store_true",
                       help="Apenas gera um novo token e sai")
    
    parser.add_argument("--host",
                       default="0.0.0.0",
                       help="Host/IP de bind do servidor (padrão: 0.0.0.0)")
    
    args = parser.parse_args()
    
    workspace_root = get_workspace_root()
    
    # Se apenas gerar token
    if args.generate_token:
        token = generate_token()
        print(f"🔐 Token gerado: {token}")
        return
    
    # Modo read-only requer um token
    token = args.token
    if args.mode == "readonly" and not token:
        token = generate_token()
    
    # Criar configurações
    create_env_file(workspace_root, args.mode, args.port, token)
    config = create_publish_config(workspace_root, args.mode, args.port, token)
    
    # Exibir informações
    print_connection_info(args.port, args.mode, token, hostname="localhost")
    
    # Instrução para executar
    print("➡️  Para iniciar o servidor, execute:")
    print(f"   python app.py")
    print("\n⚠️  Certifique-se de ter instalado as dependências com: pip install -r requirements.txt")
    
    return 0

if __name__ == "__main__":
    sys.exit(main() or 0)
