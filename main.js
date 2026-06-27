const ASSETS = {
  background: "assets/bg.png",
  walkMask: "assets/walk_mask.png",
  characters: {
    front_ne: "assets/characters/front_ne.png",
    front_nw: "assets/characters/front_nw.png",
    front_se: "assets/characters/front_se.png",
    front_sw: "assets/characters/front_sw.png",
    rear_ne: "assets/characters/rear_ne.png",
    rear_nw: "assets/characters/rear_nw.png",
    rear_se: "assets/characters/rear_se.png",
    rear_sw: "assets/characters/rear_sw.png",
  },
};

const GRID_SIZE = 16;
const PLAYER_RADIUS = 10;
const PLAYER_SPEED = 90;
const ACCELERATION = 420;
const MOVING_FRICTION = 0.992;
const IDLE_FRICTION = 0.88;
const MAX_SPEED = 90;
const TURN_RATE = 7.0;
const GOAL_RADIUS = 28;
const MIN_GOAL_DISTANCE = 300;
const PLAYER_START = { x: 500, y: 1400 };
const CAMERA_ZOOM = 3;
const GOAL_EDGE_MARGIN = 34;

const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");
const clearPanel = document.getElementById("clearPanel");
const restartButton = document.getElementById("restartButton");
const toggleMask = document.getElementById("toggleMask");
const toggleGrid = document.getElementById("toggleGrid");
const togglePath = document.getElementById("togglePath");

const images = {};
const sprites = {};
const debug = {
  mask: false,
  grid: false,
  path: true,
};

const view = {
  width: 0,
  height: 0,
  dpr: 1,
  scale: 1,
  offsetX: 0,
  offsetY: 0,
};

const maskCanvas = document.createElement("canvas");
const maskCtx = maskCanvas.getContext("2d", { willReadFrequently: true });
let maskData = null;
let mapWidth = 0;
let mapHeight = 0;
let gridWidth = 0;
let gridHeight = 0;
let walkGrid = [];
let walkableCells = [];
let lastTime = 0;
let clickEffect = null;
let goalPulse = 0;
let bubbleTimer = 0;
let bubbleVisibleTime = 0;
let startArrowTime = 0;
let gameCleared = false;

const player = {
  x: PLAYER_START.x,
  y: PLAYER_START.y,
  vx: 0,
  vy: 0,
  path: [],
  spriteKey: "front_se",
  walkTime: 0,
};

let goal = { x: 0, y: 0 };

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Failed to load ${src}`));
    image.src = src;
  });
}

async function loadAssets() {
  images.background = await loadImage(ASSETS.background);
  images.walkMask = await loadImage(ASSETS.walkMask);
  const spriteEntries = Object.entries(ASSETS.characters);
  await Promise.all(
    spriteEntries.map(async ([key, src]) => {
      sprites[key] = await loadImage(src);
    }),
  );

  mapWidth = images.background.naturalWidth;
  mapHeight = images.background.naturalHeight;
  if (images.walkMask.naturalWidth !== mapWidth || images.walkMask.naturalHeight !== mapHeight) {
    throw new Error("Background and walk mask sizes must match.");
  }

  maskCanvas.width = mapWidth;
  maskCanvas.height = mapHeight;
  maskCtx.drawImage(images.walkMask, 0, 0);
  maskData = maskCtx.getImageData(0, 0, mapWidth, mapHeight).data;
}

function resizeCanvas() {
  view.dpr = Math.min(window.devicePixelRatio || 1, 2);
  view.width = window.innerWidth;
  view.height = window.innerHeight;
  canvas.width = Math.floor(view.width * view.dpr);
  canvas.height = Math.floor(view.height * view.dpr);
  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  updateCamera();
}

function updateCamera() {
  if (!mapWidth || !mapHeight) return;
  const isPhonePortrait = view.width <= 720 && view.height > view.width;
  const baseScale = isPhonePortrait
    ? view.width / mapWidth
    : Math.min(view.width / mapWidth, view.height / mapHeight);
  view.scale = baseScale * CAMERA_ZOOM;

  const scaledW = mapWidth * view.scale;
  const scaledH = mapHeight * view.scale;
  view.offsetX = view.width / 2 - player.x * view.scale;
  view.offsetY = view.height / 2 - player.y * view.scale;

  if (scaledW <= view.width) {
    view.offsetX = (view.width - scaledW) / 2;
  } else {
    view.offsetX = clamp(view.offsetX, view.width - scaledW, 0);
  }

  if (scaledH <= view.height) {
    view.offsetY = (view.height - scaledH) / 2;
  } else {
    view.offsetY = clamp(view.offsetY, view.height - scaledH, 0);
  }
}

function screenToMap(x, y) {
  return {
    x: (x - view.offsetX) / view.scale,
    y: (y - view.offsetY) / view.scale,
  };
}

function mapToScreen(x, y) {
  return {
    x: x * view.scale + view.offsetX,
    y: y * view.scale + view.offsetY,
  };
}

function isWhite(r, g, b, a) {
  return a > 128 && r > 180 && g > 180 && b > 180;
}

function isWalkablePixel(x, y) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  if (ix < 0 || iy < 0 || ix >= mapWidth || iy >= mapHeight || !maskData) return false;
  const index = (iy * mapWidth + ix) * 4;
  return isWhite(maskData[index], maskData[index + 1], maskData[index + 2], maskData[index + 3]);
}

function isWalkableCircle(x, y, radius = PLAYER_RADIUS) {
  const points = [
    [0, 0],
    [radius, 0],
    [-radius, 0],
    [0, radius],
    [0, -radius],
    [radius * 0.7, radius * 0.7],
    [-radius * 0.7, radius * 0.7],
    [radius * 0.7, -radius * 0.7],
    [-radius * 0.7, -radius * 0.7],
  ];
  return points.every(([dx, dy]) => isWalkablePixel(x + dx, y + dy));
}

function findNearestWalkable(x, y, maxRadius = 180) {
  if (isWalkableCircle(x, y)) return { x, y };
  const step = 8;
  for (let radius = step; radius <= maxRadius; radius += step) {
    const samples = Math.max(16, Math.ceil((radius * Math.PI * 2) / step));
    for (let i = 0; i < samples; i += 1) {
      const angle = (i / samples) * Math.PI * 2;
      const px = x + Math.cos(angle) * radius;
      const py = y + Math.sin(angle) * radius;
      if (isWalkableCircle(px, py)) return { x: px, y: py };
    }
  }
  return null;
}

function buildGridFromMask() {
  gridWidth = Math.ceil(mapWidth / GRID_SIZE);
  gridHeight = Math.ceil(mapHeight / GRID_SIZE);
  walkGrid = Array.from({ length: gridHeight }, () => Array(gridWidth).fill(false));
  walkableCells = [];

  for (let gy = 0; gy < gridHeight; gy += 1) {
    for (let gx = 0; gx < gridWidth; gx += 1) {
      const point = gridToMap(gx, gy);
      const ok = isWalkableCircle(point.x, point.y);
      walkGrid[gy][gx] = ok;
      if (ok) walkableCells.push({ x: gx, y: gy });
    }
  }
}

function gridToMap(gx, gy) {
  return {
    x: gx * GRID_SIZE + GRID_SIZE / 2,
    y: gy * GRID_SIZE + GRID_SIZE / 2,
  };
}

function mapToGrid(point) {
  return {
    x: clamp(Math.floor(point.x / GRID_SIZE), 0, gridWidth - 1),
    y: clamp(Math.floor(point.y / GRID_SIZE), 0, gridHeight - 1),
  };
}

function nearestWalkableCell(cell, maxRadius = 14) {
  if (walkGrid[cell.y]?.[cell.x]) return cell;
  for (let r = 1; r <= maxRadius; r += 1) {
    for (let y = cell.y - r; y <= cell.y + r; y += 1) {
      for (let x = cell.x - r; x <= cell.x + r; x += 1) {
        if (walkGrid[y]?.[x]) return { x, y };
      }
    }
  }
  return null;
}

function octileDistance(a, b) {
  const dx = Math.abs(a.x - b.x);
  const dy = Math.abs(a.y - b.y);
  return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
}

function findPathAStar(start, target) {
  const startCell = nearestWalkableCell(mapToGrid(start));
  const goalCell = nearestWalkableCell(mapToGrid(target));
  if (!startCell || !goalCell) return [];

  const startKey = nodeKey(startCell.x, startCell.y);
  const goalKey = nodeKey(goalCell.x, goalCell.y);
  const open = [
    {
      x: startCell.x,
      y: startCell.y,
      g: 0,
      h: octileDistance(startCell, goalCell),
      f: octileDistance(startCell, goalCell),
      parent: null,
    },
  ];
  const best = new Map([[startKey, open[0]]]);
  const closed = new Set();

  while (open.length) {
    let bestIndex = 0;
    for (let i = 1; i < open.length; i += 1) {
      if (open[i].f < open[bestIndex].f) bestIndex = i;
    }
    const current = open.splice(bestIndex, 1)[0];
    const currentKey = nodeKey(current.x, current.y);
    if (closed.has(currentKey)) continue;
    if (currentKey === goalKey) {
      return smoothPath(reconstructPath(current, target));
    }
    closed.add(currentKey);

    for (const next of getNeighbors(current)) {
      const key = nodeKey(next.x, next.y);
      if (closed.has(key)) continue;
      const g = current.g + next.cost;
      const previous = best.get(key);
      if (previous && g >= previous.g) continue;
      const h = octileDistance(next, goalCell);
      const node = {
        x: next.x,
        y: next.y,
        g,
        h,
        f: g + h,
        parent: current,
      };
      best.set(key, node);
      open.push(node);
    }
  }

  return [];
}

function getNeighbors(node) {
  const dirs = [
    [0, -1, 1],
    [0, 1, 1],
    [-1, 0, 1],
    [1, 0, 1],
    [-1, -1, Math.SQRT2],
    [1, -1, Math.SQRT2],
    [-1, 1, Math.SQRT2],
    [1, 1, Math.SQRT2],
  ];
  const result = [];
  for (const [dx, dy, cost] of dirs) {
    const x = node.x + dx;
    const y = node.y + dy;
    if (!walkGrid[y]?.[x]) continue;
    if (dx !== 0 && dy !== 0) {
      if (!walkGrid[node.y]?.[node.x + dx] || !walkGrid[node.y + dy]?.[node.x]) continue;
    }
    result.push({ x, y, cost });
  }
  return result;
}

function reconstructPath(node, finalTarget) {
  const path = [];
  let current = node;
  while (current) {
    path.push(gridToMap(current.x, current.y));
    current = current.parent;
  }
  path.reverse();
  if (isWalkableCircle(finalTarget.x, finalTarget.y) && hasLineOfSight(path[path.length - 2] || path[0], finalTarget)) {
    path[path.length - 1] = finalTarget;
  }
  return path;
}

function smoothPath(path) {
  if (path.length <= 2) return path;
  const result = [path[0]];
  let anchor = 0;
  while (anchor < path.length - 1) {
    let next = anchor + 1;
    for (let i = path.length - 1; i > anchor + 1; i -= 1) {
      if (hasLineOfSight(path[anchor], path[i])) {
        next = i;
        break;
      }
    }
    result.push(path[next]);
    anchor = next;
  }
  return result;
}

function hasLineOfSight(a, b) {
  const distance = Math.hypot(b.x - a.x, b.y - a.y);
  const steps = Math.max(1, Math.ceil(distance / 8));
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t;
    if (!isWalkableCircle(x, y)) return false;
  }
  return true;
}

function setRandomStartAndGoal() {
  const start = toSafeCellCenter(findNearestWalkable(PLAYER_START.x, PLAYER_START.y, 420)) || randomWalkablePoint(true);
  player.x = start.x;
  player.y = start.y;
  player.vx = 0;
  player.vy = 0;
  player.path = [];
  gameCleared = false;
  startArrowTime = 3;
  clearPanel.hidden = true;

  for (let i = 0; i < 240; i += 1) {
    const candidate = randomWalkablePoint(false);
    if (Math.hypot(candidate.x - player.x, candidate.y - player.y) < MIN_GOAL_DISTANCE) continue;
    goal = candidate;
    return;
  }

  goal = randomWalkablePoint(false);
}

function randomWalkablePoint(preferBottom) {
  const candidates = preferBottom
    ? walkableCells.filter((cell) => gridToMap(cell.x, cell.y).y > mapHeight * 0.62)
    : walkableCells;
  const list = candidates.length ? candidates : walkableCells;
  for (let i = 0; i < 400; i += 1) {
    const cell = list[Math.floor(Math.random() * list.length)];
    const point = gridToMap(cell.x, cell.y);
    if (isWalkableCircle(point.x, point.y)) return point;
  }
  return { x: PLAYER_START.x, y: PLAYER_START.y };
}

function toSafeCellCenter(point) {
  if (!point) return null;
  const cell = nearestWalkableCell(mapToGrid(point));
  return cell ? gridToMap(cell.x, cell.y) : null;
}

function updatePlayer(deltaTime) {
  if (gameCleared) return;

  const next = player.path[0];
  let desiredX = 0;
  let desiredY = 0;

  if (next) {
    const dx = next.x - player.x;
    const dy = next.y - player.y;
    const distance = Math.hypot(dx, dy);
    if (distance < 12) {
      player.vx = 0;
      player.vy = 0;
      player.path.shift();
    } else {
      desiredX = dx / distance;
      desiredY = dy / distance;
    }
  }

  const desiredAngle = Math.atan2(desiredY, desiredX);
  const currentSpeed = Math.hypot(player.vx, player.vy);
  const currentAngle = currentSpeed > 0.01 ? Math.atan2(player.vy, player.vx) : desiredAngle;
  const angle = rotateToward(currentAngle, desiredAngle, TURN_RATE * deltaTime);
  const targetSpeed = next ? MAX_SPEED : 0;
  const targetVx = Math.cos(angle) * targetSpeed;
  const targetVy = Math.sin(angle) * targetSpeed;

  player.vx = moveToward(player.vx, targetVx, ACCELERATION * deltaTime);
  player.vy = moveToward(player.vy, targetVy, ACCELERATION * deltaTime);
  const friction = next ? MOVING_FRICTION : IDLE_FRICTION;
  player.vx *= Math.pow(friction, deltaTime * 60);
  player.vy *= Math.pow(friction, deltaTime * 60);

  const speed = Math.hypot(player.vx, player.vy);
  if (speed > PLAYER_SPEED) {
    player.vx = (player.vx / speed) * PLAYER_SPEED;
    player.vy = (player.vy / speed) * PLAYER_SPEED;
  }

  const nx = player.x + player.vx * deltaTime;
  const ny = player.y + player.vy * deltaTime;
  if (isWalkableCircle(nx, ny)) {
    player.x = nx;
    player.y = ny;
  } else {
    const movedX = player.x + player.vx * deltaTime;
    const movedY = player.y + player.vy * deltaTime;
    if (isWalkableCircle(movedX, player.y)) {
      player.x = movedX;
      player.vy *= 0.3;
    } else if (isWalkableCircle(player.x, movedY)) {
      player.y = movedY;
      player.vx *= 0.3;
    } else {
      player.vx *= 0.3;
      player.vy *= 0.3;
    }
  }

  updateSpriteDirection();
  player.walkTime += deltaTime;
  bubbleTimer += deltaTime;
  if (bubbleTimer > 7.5) {
    bubbleTimer = 0;
    bubbleVisibleTime = 1.8;
  }
  bubbleVisibleTime = Math.max(0, bubbleVisibleTime - deltaTime);
  startArrowTime = Math.max(0, startArrowTime - deltaTime);

  if (Math.hypot(player.x - goal.x, player.y - goal.y) <= GOAL_RADIUS) {
    gameCleared = true;
    player.path = [];
    player.vx = 0;
    player.vy = 0;
    clearPanel.hidden = false;
  }
}

function updateSpriteDirection() {
  const vx = player.vx;
  const vy = player.vy;
  if (Math.hypot(vx, vy) < 2) return;
  if (vy >= 0) {
    player.spriteKey = vx >= 0 ? "front_se" : "front_sw";
  } else {
    player.spriteKey = vx >= 0 ? "rear_ne" : "rear_nw";
  }
}

function draw() {
  updateCamera();
  ctx.clearRect(0, 0, view.width, view.height);
  ctx.fillStyle = "#101417";
  ctx.fillRect(0, 0, view.width, view.height);

  ctx.save();
  ctx.translate(view.offsetX, view.offsetY);
  ctx.scale(view.scale, view.scale);
  ctx.drawImage(images.background, 0, 0);

  if (debug.mask) {
    ctx.save();
    ctx.globalAlpha = 0.35;
    ctx.drawImage(images.walkMask, 0, 0);
    ctx.restore();
  }

  if (debug.grid) drawGrid();
  if (debug.path) drawPath();
  drawGoal();
  drawClickEffect();
  drawPlayer();
  drawStartArrow();
  ctx.restore();
  drawGoalEdgeIndicator();
}

function drawGrid() {
  ctx.save();
  ctx.globalAlpha = 0.18;
  ctx.lineWidth = 1 / view.scale;
  for (let y = 0; y < gridHeight; y += 1) {
    for (let x = 0; x < gridWidth; x += 1) {
      if (!walkGrid[y][x]) continue;
      ctx.strokeStyle = "#68d6ff";
      ctx.strokeRect(x * GRID_SIZE, y * GRID_SIZE, GRID_SIZE, GRID_SIZE);
    }
  }
  ctx.restore();
}

function drawPath() {
  if (!player.path.length) return;
  ctx.save();
  ctx.strokeStyle = "rgba(104, 214, 255, 0.7)";
  ctx.lineWidth = 5;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(player.x, player.y);
  for (const point of player.path) ctx.lineTo(point.x, point.y);
  ctx.stroke();
  ctx.restore();
}

function drawGoal() {
  goalPulse += 0.05;
  const pulse = 1 + Math.sin(goalPulse) * 0.12;
  ctx.save();
  ctx.translate(goal.x, goal.y);
  ctx.globalAlpha = 0.36;
  ctx.fillStyle = "#fff16a";
  ctx.beginPath();
  ctx.arc(0, 0, GOAL_RADIUS * 1.65 * pulse, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#ffe35e";
  ctx.strokeStyle = "#4b3411";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(0, 0, GOAL_RADIUS * pulse, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#3b2608";
  ctx.font = "900 16px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("GOAL", 0, 1);
  ctx.restore();
}

function drawGoalEdgeIndicator() {
  const goalScreen = mapToScreen(goal.x, goal.y);
  const margin = GOAL_EDGE_MARGIN;
  const safeTop = view.width <= 520 ? 160 : 90;
  const visible =
    goalScreen.x >= margin &&
    goalScreen.x <= view.width - margin &&
    goalScreen.y >= safeTop &&
    goalScreen.y <= view.height - margin;
  if (visible) return;

  const centerX = view.width / 2;
  const centerY = view.height / 2;
  const dx = goalScreen.x - centerX;
  const dy = goalScreen.y - centerY;
  const angle = Math.atan2(dy, dx);

  const x = clamp(goalScreen.x, margin, view.width - margin);
  const y = clamp(goalScreen.y, safeTop, view.height - margin);

  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = "rgba(255, 227, 94, 0.96)";
  ctx.strokeStyle = "#4b3411";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(0, 0, 24, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.save();
  ctx.rotate(angle);
  ctx.fillStyle = "#4b3411";
  ctx.beginPath();
  ctx.moveTo(19, 0);
  ctx.lineTo(7, -7);
  ctx.lineTo(7, 7);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  ctx.fillStyle = "#3b2608";
  ctx.font = "900 9px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("GOAL", 0, 1);
  ctx.restore();
}

function drawClickEffect() {
  if (!clickEffect) return;
  clickEffect.age += 1 / 60;
  const t = Math.min(1, clickEffect.age / 0.5);
  ctx.save();
  ctx.strokeStyle = `rgba(96, 214, 255, ${1 - t})`;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(clickEffect.x, clickEffect.y, 10 + t * 36, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
  if (t >= 1) clickEffect = null;
}

function drawPlayer() {
  const sprite = sprites[player.spriteKey] || sprites.front_se;
  const spriteW = 76;
  const spriteH = 76;
  const footOffset = 17;
  const bob = Math.sin(player.walkTime * 12) * Math.min(3, Math.hypot(player.vx, player.vy) / 30);

  ctx.save();
  ctx.globalAlpha = 0.32;
  ctx.fillStyle = "#000";
  ctx.beginPath();
  ctx.ellipse(player.x, player.y + 3, 18, 7, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.drawImage(sprite, player.x - spriteW / 2, player.y - spriteH + footOffset + bob, spriteW, spriteH);

  if (bubbleVisibleTime > 0 && !gameCleared) {
    ctx.fillStyle = "rgba(255, 255, 255, 0.92)";
    ctx.strokeStyle = "rgba(40, 30, 20, 0.35)";
    ctx.lineWidth = 2;
    roundedRect(ctx, player.x + 20, player.y - 84, 94, 30, 8);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#3a3026";
    ctx.font = "700 13px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("こっちかな…？", player.x + 67, player.y - 69);
  }
  ctx.restore();
}

function drawStartArrow() {
  if (startArrowTime <= 0 || gameCleared) return;
  const alpha = Math.min(1, startArrowTime / 0.5);
  const bob = Math.sin((3 - startArrowTime) * 8) * 7;

  ctx.save();
  ctx.translate(player.x, player.y - 100 + bob);
  ctx.globalAlpha = alpha;
  ctx.fillStyle = "#ffe45f";
  ctx.strokeStyle = "#43280b";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(0, 34);
  ctx.lineTo(-22, 6);
  ctx.lineTo(-9, 6);
  ctx.lineTo(-9, -28);
  ctx.lineTo(9, -28);
  ctx.lineTo(9, 6);
  ctx.lineTo(22, 6);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function gameLoop(timestamp) {
  const deltaTime = Math.min(0.04, (timestamp - lastTime) / 1000 || 0);
  lastTime = timestamp;
  updatePlayer(deltaTime);
  draw();
  requestAnimationFrame(gameLoop);
}

function handlePointer(event) {
  if (gameCleared) return;
  const rect = canvas.getBoundingClientRect();
  const mapPoint = screenToMap(event.clientX - rect.left, event.clientY - rect.top);
  const destination = findNearestWalkable(mapPoint.x, mapPoint.y, 220);
  if (!destination) return;

  if (!hasLineOfSight({ x: player.x, y: player.y }, destination)) return;

  player.path = [destination];
  player.vx = 0;
  player.vy = 0;
  clickEffect = { x: destination.x, y: destination.y, age: 0 };
}

function restartGame() {
  setRandomStartAndGoal();
}

function bindControls() {
  canvas.addEventListener("pointerdown", handlePointer);
  restartButton.addEventListener("click", restartGame);
  window.addEventListener("resize", resizeCanvas);

  toggleMask.addEventListener("click", () => toggleDebug("mask", toggleMask));
  toggleGrid.addEventListener("click", () => toggleDebug("grid", toggleGrid));
  togglePath.addEventListener("click", () => toggleDebug("path", togglePath));
  togglePath.classList.toggle("active", debug.path);
}

function toggleDebug(key, button) {
  debug[key] = !debug[key];
  button.classList.toggle("active", debug[key]);
}

function nodeKey(x, y) {
  return `${x},${y}`;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function moveToward(current, target, maxDelta) {
  if (Math.abs(target - current) <= maxDelta) return target;
  return current + Math.sign(target - current) * maxDelta;
}

function rotateToward(current, target, maxDelta) {
  if (!Number.isFinite(target)) return current;
  let diff = target - current;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  if (Math.abs(diff) <= maxDelta) return target;
  return current + Math.sign(diff) * maxDelta;
}

function roundedRect(context, x, y, width, height, radius) {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.lineTo(x + width - radius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + radius);
  context.lineTo(x + width, y + height - radius);
  context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  context.lineTo(x + radius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - radius);
  context.lineTo(x, y + radius);
  context.quadraticCurveTo(x, y, x + radius, y);
  context.closePath();
}

async function init() {
  await loadAssets();
  resizeCanvas();
  buildGridFromMask();
  setRandomStartAndGoal();
  bindControls();
  requestAnimationFrame(gameLoop);
}

init().catch((error) => {
  console.error(error);
  ctx.fillStyle = "#fff";
  ctx.font = "16px sans-serif";
  ctx.fillText("ゲームの読み込みに失敗しました", 20, 40);
});
