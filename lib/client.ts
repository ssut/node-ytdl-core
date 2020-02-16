import axios from 'axios';
import axiosCookieJarSupport from 'axios-cookiejar-support';
import * as toughCookie from 'tough-cookie';

axiosCookieJarSupport(axios);

const cookieJar = new toughCookie.CookieJar();
const request = axios.create({
  jar: cookieJar,
  withCredentials: true,
  maxRedirects: 5,
});

export default request;
