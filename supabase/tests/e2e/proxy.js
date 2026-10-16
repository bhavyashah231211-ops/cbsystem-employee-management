const http=require("http");
http.createServer((req,res)=>{
  const url=req.url.replace(/^\/rest\/v1/,"");
  const p=http.request({host:"127.0.0.1",port:3000,path:url,method:req.method,headers:req.headers},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res)});
  req.pipe(p);p.on("error",e=>{res.writeHead(502);res.end(String(e))});
}).listen(54321);
