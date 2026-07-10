import React, { useEffect } from 'react';

const Greetings = () => {
const [dateTime, setDateTime] = React.useState(new Date());

useEffect(() => {
    const timer = setInterval(() => { setDateTime(new Date()); }, 1000);
    return () => clearInterval(timer);
  }, []);

  const formatDate = (date) => {
    const months = [
      "January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December"
    ];
    return `${months[date.getMonth()]} ${String(date.getDate()).padStart(2, '0')}, ${date.getFullYear()}`;
    };

    const formatTime = (date) => {
        return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
    }



    return (
    <div className="flex justify-between items-center px-8 mt-5">
        <div>
            <h1 className="text-2xl font-semibold text-gray-100 tracking-wide">Good Morning Cale!</h1>
            <p className="text-sm text-gray-200">Manage your orders and tables efficiently.</p>

        </div>
        <div>
            <h1 className="text-3xl text-gray-100 font-bold tracking-wide w-[130px]">{formatTime(dateTime)}</h1>
            <p className="text-gray-200 text-sm">{formatDate(dateTime)}</p>
        </div>





    </div>
    )
}

export default Greetings;
