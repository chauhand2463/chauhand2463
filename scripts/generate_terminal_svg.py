from PIL import Image

WIDTH = 42
CHARS = "@%#*+=-:. "

img = Image.open("scripts/avatar.jpg").convert("L")

w, h = img.size
new_h = int((h / w) * WIDTH * 0.55)

img = img.resize((WIDTH, new_h))

pixels = img.load()

lines = []

for y in range(img.height):
    line = ""
    for x in range(img.width):
        val = pixels[x, y]
        line += CHARS[val * (len(CHARS)-1)//255]
    lines.append(line)

with open("profile/ascii.txt","w") as f:
    f.write("\n".join(lines))
