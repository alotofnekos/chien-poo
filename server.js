
import express from 'express';

const app = express();

app.get('/', (req, res) => {
  res.send('Bot is alive!');
});

const keepAlive = () => {
  app.listen(3000, () => {
    console.log('Server is ready.');
  });
};

export default keepAlive;
