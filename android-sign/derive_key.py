# Gera a chave de assinatura do Android a partir da senha (segredo ANDROID_KEY_PASSWORD).
# A mesma senha sempre gera a mesma chave, então não é preciso guardar um arquivo de chave.
# Uso: python3 derive_key.py <saida.pk8> [--cert cert.pem para conferir]
import hashlib, os, re, sys
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives import serialization
from cryptography import x509

def derive(password: str):
    pw = re.sub(r"[^A-Za-z0-9]", "", password)          # ignora espaços/invisíveis colados por engano
    if not pw: sys.exit("::error::Segredo ANDROID_KEY_PASSWORD vazio.")
    n = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551   # ordem da curva P-256
    d = int.from_bytes(hashlib.sha256(b"estante-mangas-assinatura-v1:" + pw.encode()).digest(), "big") % (n - 1) + 1
    return ec.derive_private_key(d, ec.SECP256R1())

if __name__ == "__main__":
    key = derive(os.environ.get("KS_PASS", ""))
    out = sys.argv[1]
    open(out, "wb").write(key.private_bytes(serialization.Encoding.DER, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    if "--cert" in sys.argv:
        cert = x509.load_pem_x509_certificate(open(sys.argv[sys.argv.index("--cert") + 1], "rb").read())
        pub = lambda k: k.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
        if pub(cert.public_key()) != pub(key.public_key()):
            sys.exit("::error::A senha (ANDROID_KEY_PASSWORD) não confere com o certificado do app.")
    print("Chave de assinatura pronta.")
