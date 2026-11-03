// 武器資料：之後的自訂武器 / 裝備系統會從這裡擴充
export const WEAPONS = {
  rifle: {
    name: '突擊步槍',
    mag: 12,            // 彈匣容量
    fireInterval: 0.1,  // 射擊間隔（秒）
    reload: 1.15,       // 換彈時間（秒）
    spread: 0.07,       // 散布（弧度）
    speed: 34,          // 子彈速度
    damage: 1,
    pellets: 1,
    recoil: 1.6,        // 每發往後推的速度
    shake: 0.07,
    noise: 10,          // 槍聲會驚動幾格內的敵人
  },
};
