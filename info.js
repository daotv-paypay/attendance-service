import ZKLib from "node-zklib";

const zk = new ZKLib("192.168.1.68", 4370, 10000, 4000);

async function test() {
  try {
    await zk.createSocket();

    console.log("connected");

    const info = await zk.getInfo();
    console.log("Device info:", info);

    const users = await zk.getUsers();
    console.log("Users:", users);

    const logs = await zk.getAttendances();
    console.log("Logs:", logs?.data?.length);

    await zk.disconnect();
  } catch (e) {
    console.error(e);
  }
}

test();
