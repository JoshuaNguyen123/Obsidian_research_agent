import json
import math
import os
import sys


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=True, separators=(",", ":")))
    sys.stdout.flush()


def fail(code, message, model="", dim=0):
    emit({"ok": False, "model": model, "dim": dim, "code": code, "message": message})


def as_vector(value):
    if hasattr(value, "tolist"):
        value = value.tolist()
    return [float(item) for item in value]


def layer_norm(values):
    if not values:
        return values
    mean = sum(values) / len(values)
    variance = sum((item - mean) ** 2 for item in values) / len(values)
    scale = math.sqrt(variance + 1e-12)
    return [(item - mean) / scale for item in values]


def l2_norm(values):
    magnitude = math.sqrt(sum(item * item for item in values))
    if magnitude <= 0:
        return values
    return [item / magnitude for item in values]


def matryoshka(values, dim):
    normalized = layer_norm(as_vector(values))
    if len(normalized) < dim:
        raise ValueError(
            "embedding dimension %d is smaller than requested dim %d"
            % (len(normalized), dim)
        )
    return l2_norm(normalized[:dim])


def iter_vectors(values):
    for item in values:
        raw = item.tolist() if hasattr(item, "tolist") else item
        if raw is None:
            continue
        raw = list(raw)
        if not raw:
            continue
        if isinstance(raw[0], (int, float)):
            yield raw
            continue
        for vector in raw:
            yield vector


def main():
    try:
        request = json.loads(sys.stdin.read())
    except Exception as error:
        fail("invalid_json", str(error))
        return

    model = str(request.get("model") or "nomic-ai/nomic-embed-text-v1.5-Q")
    dim = int(request.get("dim") or 512)
    cache_dir = str(request.get("cacheDir") or "").strip()
    documents = request.get("documents") or []
    queries = request.get("queries") or []

    if dim not in (256, 512):
        fail("invalid_dim", "dim must be 256 or 512", model, dim)
        return

    if cache_dir:
        os.makedirs(cache_dir, exist_ok=True)
        os.environ["FASTEMBED_CACHE_PATH"] = cache_dir

    try:
        from fastembed import TextEmbedding
    except ImportError:
        fail(
            "missing_fastembed",
            "Install FastEmbed with: python -m pip install fastembed",
            model,
            dim,
        )
        return

    try:
        try:
            embedding_model = TextEmbedding(model_name=model, cache_dir=cache_dir or None)
        except TypeError:
            embedding_model = TextEmbedding(model_name=model)

        list(embedding_model.embed(["search_query: warmup"], batch_size=1))
        document_inputs = ["search_document: " + str(item) for item in documents]
        query_inputs = ["search_query: " + str(item) for item in queries]
        document_vectors = []
        query_vectors = []
        if document_inputs:
            for vector in iter_vectors(
                embedding_model.embed(document_inputs, batch_size=16)
            ):
                document_vectors.append(matryoshka(vector, dim))
        if query_inputs:
            for vector in iter_vectors(
                embedding_model.embed(query_inputs, batch_size=16)
            ):
                query_vectors.append(matryoshka(vector, dim))
    except Exception as error:
        fail("embed_failed", str(error), model, dim)
        return

    emit(
        {
            "ok": True,
            "model": model,
            "dim": dim,
            "documents": document_vectors,
            "queries": query_vectors,
            "downloadedOrVerified": True,
            "cacheDir": cache_dir,
        }
    )


main()
