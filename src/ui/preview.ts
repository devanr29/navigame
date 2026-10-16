// Third-person view of the player character on the briefing and debrief screens (GDD "Views"):
// shows the full outfit and the scarf with its badge from the back.
import * as THREE from 'three';
import { makeCharacter } from '../world/characters';

export class CharacterPreview {
  readonly canvas = document.createElement('canvas');
  private renderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(30, 1, 0.01, 20);
  private model = makeCharacter('compasman');
  private running = false;
  private t = 0;

  constructor() {
    this.canvas.className = 'preview';
    this.scene.background = new THREE.Color(0x24342a);
    this.scene.add(this.model.group);
    const ground = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.04, 24), new THREE.MeshBasicMaterial({ color: 0x5f8a4a }));
    ground.position.y = -0.02;
    this.scene.add(ground);
    this.camera.position.set(0, 0.42, 1.55);
    this.camera.lookAt(0, 0.34, 0);
  }

  start() {
    if (!this.renderer) {
      try {
        this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
      } catch {
        return; // no second WebGL context available: the screen still works without the picture
      }
    }
    this.running = true;
    let last = performance.now();
    const loop = (now: number) => {
      if (!this.running || !this.renderer) return;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      this.t += dt;
      const r = this.canvas.getBoundingClientRect();
      if (r.width > 0 && (this.canvas.width !== Math.round(r.width * 1.5) || this.canvas.height !== Math.round(r.height * 1.5))) {
        this.renderer.setPixelRatio(1.5);
        this.renderer.setSize(r.width, r.height, false);
        this.camera.aspect = r.width / r.height;
        this.camera.updateProjectionMatrix();
      }
      // Turn all the way round (face and scarf front, then the badge on the back), slowing down at
      // the back so the badge is seen. 0 = back to the camera.
      const a = this.t * 0.55;
      this.model.group.rotation.y = a - 0.45 * Math.sin(a);
      this.model.animate(dt, 0.3);
      this.renderer.render(this.scene, this.camera);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
  }
}
