"""Face + speaking-motion analysis for oukos clip.

Reads raw BGR24 frames from stdin (piped from ffmpeg), runs OpenCV's YuNet face
detector on each one and prints JSON to stdout:

  {"samples": [{"t": 0.0, "cut": 0.0, "faces": [{"x","y","w","h","s","m"}]}]}

x/y/w/h are normalised to 0..1, s is detector confidence, m is mouth motion
compared with the same face in the previous sample (a rough "is talking" signal),
cut is how different the frame is from the previous one (scene-change signal).
"""

import argparse
import json
import sys

import cv2
import numpy as np


def read_exact(stream, size):
    chunks = []
    remaining = size
    while remaining:
        chunk = stream.read(remaining)
        if not chunk:
            break
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def iou(a, b):
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    ix = max(0.0, min(ax + aw, bx + bw) - max(ax, bx))
    iy = max(0.0, min(ay + ah, by + bh) - max(ay, by))
    inter = ix * iy
    union = aw * ah + bw * bh - inter
    return inter / union if union > 0 else 0.0


def patch(gray, x, y, w, h, size):
    H, W = gray.shape
    x0, y0 = max(0, int(x)), max(0, int(y))
    x1, y1 = min(W, int(x + w)), min(H, int(y + h))
    if x1 - x0 < 4 or y1 - y0 < 4:
        return None
    return cv2.resize(gray[y0:y1, x0:x1], size, interpolation=cv2.INTER_AREA).astype(np.float32)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--width", type=int, required=True)
    parser.add_argument("--height", type=int, required=True)
    parser.add_argument("--fps", type=float, required=True)
    parser.add_argument("--model", required=True)
    args = parser.parse_args()

    w, h = args.width, args.height
    detector = cv2.FaceDetectorYN.create(args.model, "", (w, h), 0.6, 0.3, 20)
    frame_size = w * h * 3
    stdin = sys.stdin.buffer

    samples = []
    prev_small = None
    prev_faces = []  # (box, mouth_patch, face_patch)
    index = 0
    while True:
        buf = read_exact(stdin, frame_size)
        if len(buf) < frame_size:
            break
        frame = np.frombuffer(buf, np.uint8).reshape(h, w, 3)
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)

        small = cv2.resize(gray, (64, 36), interpolation=cv2.INTER_AREA)
        cut = float(np.mean(cv2.absdiff(small, prev_small))) if prev_small is not None else 0.0
        prev_small = small
        if cut > 35:
            prev_faces = []

        _, detections = detector.detect(frame)
        faces_out = []
        current = []
        for det in detections if detections is not None else []:
            fx, fy, fw, fh = (float(v) for v in det[0:4])
            score = float(det[14])
            # Landmarks 10-13: right and left mouth corners.
            mrx, mry, mlx, mly = (float(v) for v in det[10:14])
            mouth_cx, mouth_cy = (mrx + mlx) / 2, (mry + mly) / 2
            mouth_w = max(abs(mlx - mrx) * 1.6, fw * 0.35)
            mouth = patch(gray, mouth_cx - mouth_w / 2, mouth_cy - fh * 0.12, mouth_w, fh * 0.32, (32, 20))
            face = patch(gray, fx, fy, fw, fh, (32, 32))

            motion = 0.0
            box = (fx, fy, fw, fh)
            best = max(prev_faces, key=lambda p: iou(p[0], box), default=None)
            if best is not None and iou(best[0], box) > 0.3 and mouth is not None and best[1] is not None:
                mouth_diff = float(np.mean(np.abs(mouth - best[1])))
                face_diff = float(np.mean(np.abs(face - best[2]))) if face is not None and best[2] is not None else 0.0
                # Subtract whole-face change so head turns / lighting don't count as talking.
                motion = max(0.0, mouth_diff - 0.6 * face_diff)
            current.append((box, mouth, face))
            faces_out.append({
                "x": round(fx / w, 4), "y": round(fy / h, 4),
                "w": round(fw / w, 4), "h": round(fh / h, 4),
                "s": round(score, 3), "m": round(motion, 2),
            })
        prev_faces = current
        samples.append({"t": round(index / args.fps, 3), "cut": round(cut, 2), "faces": faces_out})
        index += 1

    json.dump({"samples": samples}, sys.stdout)


if __name__ == "__main__":
    main()
